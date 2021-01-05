const _ = require('lodash')

const VALID_EVENT_TYPES = [
  'viewer-request',
  'origin-request',
  'viewer-response',
  'origin-response'
]

class ServerlessPluginExistingCloudFrontLambdaEdge {
  constructor(serverless, opts) {
    this._serverless = serverless
    this._provider = serverless ? serverless.getProvider('aws') : null
    this._opts = opts
    if (!this._provider) {
      throw new Error('This plugin must be used with AWS')
    }

    this._alreadyWaitingForUpdates = new Set()
    this._distIdIsWaiting = null

    this.hooks = {
      'aws:package:finalize:mergeCustomProviderResources': this._onPackageCustomResources.bind(
        this
      ),
      'before:deploy:finalize': this._onBeforeDeployFinalize.bind(this),
      'package:function:package': this._onFunctionPackage.bind(this)
    }
  }

  _onFunctionPackage() {
    this._serverless.cli.log('Function being packaged ...')
  }

  _onPackageCustomResources() {
    this._modifyTemplate()
  }

  _onBeforeDeployFinalize() {
    const cnt = this._pendingAssociations.length

    if (cnt === 0) {
      return
    }

    /**
     * Each entry in the this._pendingAssociations array looks like this:
     * {
     *    "fnLogicalName": "YourFnNameLambdaFunction",
     *    "distLogicalName": "WebsiteDistribution",
     *    "fnCurrentVersionOutputName": "YourFnNameLambdaFunctionQualifiedArn",
     *    "eventType": "origin-request",
     * }
     */

    this._serverless.cli.log(
      'Checking to see if ' +
        cnt +
        (cnt > 1 ? ' functions need ' : ' function needs ') +
        'to be associated to CloudFront'
    )

    return Promise.all([
      this._getFunctionsToAssociate(),
      this._getDistributionPhysicalIDs()
    ]).then(([fns, dist]) => this._updateDistributionsAsNecessary(fns, dist))
  }

  _modifyTemplate() {
    const template = this._serverless.service.provider
      .compiledCloudFormationTemplate

    this._modifyExecutionRole(template)
    this._modifyLambdaFunctions(this._serverless.service.functions, template)
  }

  _modifyExecutionRole(template) {
    let assumeRoleUpdated = false

    if (!template.Resources || !template.Resources.IamRoleLambdaExecution) {
      this._serverless.cli.log(
        'WARNING: no IAM role for Lambda execution found - can not modify assume role policy'
      )
      return
    }

    const statementKeys = Object.keys(
      template.Resources.IamRoleLambdaExecution.Properties
        .AssumeRolePolicyDocument.Statement
    )
    statementKeys.forEach((statementKey) => {
      const stmt =
        template.Resources.IamRoleLambdaExecution.Properties
          .AssumeRolePolicyDocument.Statement[statementKey]

      const svc = stmt.Principal.Service

      if (
        stmt.Principal &&
        svc &&
        svc.includes('lambda.amazonaws.com') &&
        !svc.includes('edgelambda.amazonaws.com')
      ) {
        svc.push('edgelambda.amazonaws.com')
        assumeRoleUpdated = true
        this._serverless.cli.log(
          'Updated Lambda assume role policy to allow Lambda@Edge to assume the role'
        )
      }
    })

    // Serverless creates a LogGroup by a specific name, and grants logs:CreateLogStream
    // and logs:PutLogEvents permissions to the function. However, on a replicated
    // function, AWS will name the log groups differently, so the Serverless-created
    // permissions will not work. Thus, we must give the function permission to create
    // log groups and streams, as well as put log events.
    //
    // Since we don't have control over the naming of the log group, we let this
    // function have permission to create and use a log group by any name.
    // See http://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/iam-identity-based-access-control-cwl.html
    template.Resources.IamRoleLambdaExecution.Properties.Policies[0].PolicyDocument.Statement.push(
      {
        Effect: 'Allow',
        Action: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogStreams'
        ],
        Resource: 'arn:aws:logs:*:*:*'
      }
    )

    if (!assumeRoleUpdated) {
      this._serverless.cli.log(
        'WARNING: was unable to update the Lambda assume role policy to allow Lambda@Edge to assume the role'
      )
    }
  }

  _modifyLambdaFunctions(functions, template) {
    const self = this

    this._pendingAssociations = _.chain(functions)
      .reduce(function (memo, fnDef, fnName) {
        if (!fnDef.lambdaAtEdge) {
          return memo
        }

        const distId = fnDef.lambdaAtEdge.distributionID || null
        const distName = fnDef.lambdaAtEdge.distribution || null
        const evtType = fnDef.lambdaAtEdge.eventType
        const dist = template.Resources[distName]

        if (!_.includes(VALID_EVENT_TYPES, evtType)) {
          throw new Error(
            '"' +
              evtType +
              '" is not a valid event type, must be one of: ' +
              VALID_EVENT_TYPES.join(', ')
          )
        }

        if (!dist && !distId) {
          throw new Error(
            'Could not find resource with logical name "' +
              distName +
              '" or there is no distributionID set'
          )
        }

        if (!distName && distId) {
          throw new Error(
            'Distribution ID "' + distId + '" requires a distribution to be set'
          )
        }

        if (!distId && dist.Type !== 'AWS::CloudFront::Distribution') {
          throw new Error(
            'Resource with logical name "' +
              distName +
              '" is not type AWS::CloudFront::Distribution'
          )
        }

        memo.push({
          fnLogicalName: self._provider.naming.getLambdaLogicalId(fnName),
          distributionID: distId,
          distLogicalName: distName,
          fnCurrentVersionOutputName: self._provider.naming.getLambdaVersionOutputLogicalId(
            fnName
          ),
          eventType: evtType
        })

        return memo
      }, [])
      .each(function (fn) {
        const fnProps = template.Resources[fn.fnLogicalName].Properties

        if (fnProps && fnProps.Environment && fnProps.Environment.Variables) {
          self._serverless.cli.log(
            'Removing ' +
              _.size(fnProps.Environment.Variables) +
              ' environment variables from function "' +
              fn.fnLogicalName +
              '" because Lambda@Edge does not support environment variables'
          )

          delete fnProps.Environment.Variables

          if (_.isEmpty(fnProps.Environment)) {
            delete fnProps.Environment
          }
        }
      })
      .value()
  }

  _updateDistributionsAsNecessary(fns, dists) {
    return Promise.all(
      _.map(dists, this._updateDistributionAsNecessary.bind(this, fns))
    )
  }

  async _waitForDistributionDeployed(distPhysicalID, distLogicalName) {
    let firstDot = true
    let running = true

    if (this._distIdIsWaiting) {
      return
    }

    const cloudfront = new this._provider.sdk.CloudFront(
      this._provider.getCredentials()
    )
    this._distIdIsWaiting = distPhysicalID

    const dotPrinter = () => {
      if (running) {
        if (firstDot) {
          this._serverless.cli.log(
            'Waiting for CloudFront distribution "' +
              distLogicalName +
              '" to be deployed'
          )
          this._serverless.cli.log('This can take awhile.')
          firstDot = false
        }
        this._serverless.cli.printDot()
        setTimeout(dotPrinter, 2000)
      }
    }

    setTimeout(dotPrinter, 1000)

    return cloudfront
      .waitFor('distributionDeployed', { Id: distPhysicalID })
      .then((data) => {
        running = false
        if (!firstDot) {
          // we have printed a dot, so clear the line
          this._serverless.cli.consoleLog('')
        }
        this._serverless.cli.log(
          'Distribution "' +
            distLogicalName +
            '" is now in "' +
            data.Distribution.Status +
            '" state'
        )
      })
  }

  _updateDistributionAsNecessary(fns, dist) {
    const distID = dist.distributionID
    const distName = dist.distLogicalName

    return this._waitForDistributionDeployed(distID, distName)
      .then(() =>
        this._provider.request('CloudFront', 'getDistribution', { Id: distID })
      )
      .then((resp) => {
        const config = resp.Distribution.DistributionConfig
        const changed = this._modifyDistributionConfigIfNeeded(
          config,
          fns[distName]
        )
        const updateParams = {
          Id: distID,
          DistributionConfig: config,
          IfMatch: resp.ETag
        }

        if (changed) {
          // const prom = this._alreadyWaitingForUpdates.has(distID + distName)
          //   ? Q.resolve()
          //   // we only need to call this once
          //   : this._provider.request('CloudFront', 'updateDistribution', updateParams)

          this._alreadyWaitingForUpdates.add(distID + distName)
          this._serverless.cli.log(
            'Updating distribution "' +
              distName +
              '" because we updated Lambda@Edge associations on it'
          )
          return this._provider
            .request('CloudFront', 'updateDistribution', updateParams)
            .then(() => this._waitForDistributionDeployed(distID, distName))
            .then(() => {
              this._serverless.cli.log(
                'Done updating distribution "' + distName + '"'
              )
            })
        }

        this._serverless.cli.log(
          'The distribution is already configured with the current versions of each Lambda@Edge function it needs'
        )
      })
  }

  _modifyDistributionConfigIfNeeded(distConfig, fns) {
    let changed = this._associateFunctionsToBehavior(
      distConfig.DefaultCacheBehavior,
      fns
    )

    _.each(
      distConfig.CacheBehaviors.Items,
      function (beh) {
        const behaviorChanged = this._associateFunctionsToBehavior(beh, fns)

        changed = changed || behaviorChanged
      }.bind(this)
    )

    return changed
  }

  _associateFunctionsToBehavior(beh, fns) {
    let changed = false

    fns.forEach((fn) => {
      const existing = _.find(beh.LambdaFunctionAssociations.Items, {
        EventType: fn.eventType
      })

      if (!existing) {
        this._serverless.cli.log(
          'Adding new Lamba@Edge association for ' +
            fn.eventType +
            ': ' +
            fn.fnARN
        )
        beh.LambdaFunctionAssociations.Items.push({
          EventType: fn.eventType,
          LambdaFunctionARN: fn.fnARN
        })
        changed = true
      } else if (existing.LambdaFunctionARN !== fn.fnARN) {
        this._serverless.cli.log(
          'Updating ' +
            fn.eventType +
            ' to use ' +
            fn.fnARN +
            ' (was ' +
            existing.LambdaFunctionARN +
            ')'
        )
        existing.LambdaFunctionARN = fn.fnARN
        changed = true
      }
    })

    if (changed) {
      beh.LambdaFunctionAssociations.Quantity =
        beh.LambdaFunctionAssociations.Items.length
    }

    return changed
  }

  _getFunctionsToAssociate() {
    const stackName = this._provider.naming.getStackName()

    return this._provider
      .request('CloudFormation', 'describeStacks', { StackName: stackName })
      .then(
        function (resp) {
          const stack = _.find(resp.Stacks, { StackName: stackName })

          if (!stack) {
            throw new Error(
              'CloudFormation did not return a stack with name "' +
                stackName +
                '"'
            )
          }

          return _.reduce(
            this._pendingAssociations,
            function (memo, pending) {
              const outputName = pending.fnCurrentVersionOutputName
              const output = _.find(stack.Outputs, { OutputKey: outputName })

              if (!output) {
                throw new Error(
                  'Stack "' +
                    stackName +
                    '" did not have an output with name "' +
                    outputName +
                    '"'
                )
              }

              if (!memo[pending.distLogicalName]) {
                memo[pending.distLogicalName] = []
              }

              memo[pending.distLogicalName].push({
                eventType: pending.eventType,
                fnARN: output.OutputValue
              })

              return memo
            },
            {}
          )
        }.bind(this)
      )
  }

  async _getDistributionPhysicalIDs() {
    const stackName = this._provider.naming.getStackName()
    const existingDistIds = _.reduce(
      this._pendingAssociations,
      function (memo, pending) {
        if (pending.distributionID) {
          memo[pending.fnLogicalName] = {
            distributionID: pending.distributionID,
            distLogicalName: pending.distLogicalName
          }
        }
        return memo
      },
      {}
    )

    // If they all had distributionIDs, no reason to query CloudFormation
    if (_.size(existingDistIds) === this._pendingAssociations.length) {
      return existingDistIds
    }

    return this._provider
      .request('CloudFormation', 'describeStackResources', {
        StackName: stackName
      })
      .then((resp) => {
        return _.reduce(
          this._pendingAssociations,
          (memo, pending) => {
            const resource = _.find(resp.StackResources, {
              LogicalResourceId: pending.distLogicalName
            })

            if (!resource) {
              throw new Error(
                'Stack "' +
                  stackName +
                  '" did not have a resource with logical name "' +
                  pending.distLogicalName +
                  '"'
              )
            }

            memo[pending.fnLogicalName] = {
              distributionID: resource.PhysicalResourceId,
              distLogicalName: pending.distLogicalName
            }

            return memo
          },
          {}
        )
      })
  }
}

module.exports = ServerlessPluginExistingCloudFrontLambdaEdge
