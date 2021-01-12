const _ = require('lodash')

const VALID_EVENT_TYPES = [
  'viewer-request',
  'origin-request',
  'viewer-response',
  'origin-response'
]

class ServerlessPluginExistingCloudFrontLambdaEdge {
  constructor(serverless, opts) {
    this.serverless = serverless
    this.provider = serverless.getProvider('aws')
    this._opts = opts
    if (!this.provider) {
      throw new Error('This plugin must be used with AWS.')
    }

    this._alreadyWaitingForUpdates = new Set()
    this._distIdIsWaiting = null

    // Create schema for your properties. For reference use https://github.com/ajv-validator/ajv
    this.serverless.configSchemaHandler.defineFunctionProperties('aws', {
      type: 'object',
      properties: {
        lambdaAtEdge: {
          type: 'object',
          properties: {
            distributionID: { type: 'string' },
            eventType: { type: 'string' }
          },
          required: ['distributionID', 'eventType'],
          additionalProperties: false
        }
      }
    })

    this.hooks = {
      'aws:package:finalize:mergeCustomProviderResources': this.onPackageCustomResources.bind(
        this
      ),
      'before:deploy:finalize': this.onBeforeDeployFinalize.bind(this)
    }
  }

  onPackageCustomResources() {
    this.modifyTemplate()
  }

  async onBeforeDeployFinalize() {
    const cnt = this._pendingAssociations.length

    if (cnt === 0) {
      return
    }

    /**
     * Each entry in the this._pendingAssociations array looks like this:
     * {
     *    "fnLogicalName": "YourFnNameLambdaFunction",
     *    "distributionID": "EXISTINGDISTID",
     *    "fnCurrentVersionOutputName": "YourFnNameLambdaFunctionQualifiedArn",
     *    "eventType": "origin-request",
     * }
     */

    this.serverless.cli.log(
      `Checking to see if ${cnt}${
        cnt > 1 ? ' functions need ' : ' function needs '
      }to be associated to CloudFront.`
    )

    return Promise.all([
      this.getFunctionsToAssociate(),
      this.getDistributionPhysicalIDs()
    ]).then(([fns, dist]) => this.updateDistributionsAsNecessary(fns, dist))
  }

  modifyTemplate() {
    const template = this.serverless.service.provider
      .compiledCloudFormationTemplate

    this.modifyExecutionRole(template)
    this.modifyLambdaFunctions(this.serverless.service.functions, template)
  }

  modifyExecutionRole(template) {
    let assumeRoleUpdated = false

    if (!_.get(template, 'Resources.IamRoleLambdaExecution')) {
      this.serverless.cli.log(
        'WARNING: no IAM role for Lambda execution found - can not modify assume role policy'
      )
      return
    }

    template.Resources.IamRoleLambdaExecution.Properties.AssumeRolePolicyDocument.Statement.forEach(
      (stmt) => {
        const svc = _.get(stmt, 'Principal.Service')

        if (
          svc &&
          svc.includes('lambda.amazonaws.com') &&
          !svc.includes('edgelambda.amazonaws.com')
        ) {
          svc.push('edgelambda.amazonaws.com')
          assumeRoleUpdated = true
          this.serverless.cli.log(
            'Updated Lambda assume role policy to allow Lambda@Edge to assume the role'
          )
        }
      }
    )

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
      this.serverless.cli.log(
        'WARNING: was unable to update the Lambda assume role policy to allow Lambda@Edge to assume the role'
      )
    }
  }

  modifyLambdaFunctions(functions, template) {
    this._pendingAssociations = _.chain(functions)
      .reduce((memo, fnDef, fnName) => {
        if (!fnDef.lambdaAtEdge) {
          return memo
        }

        const distId = fnDef.lambdaAtEdge.distributionID || null
        // const distName = fnDef.lambdaAtEdge.distribution || null
        const evtType = fnDef.lambdaAtEdge.eventType
        // const dist = template.Resources[distName]

        if (!VALID_EVENT_TYPES.includes(evtType)) {
          throw new Error(
            `"${evtType}" is not a valid event type, must be one of: ${VALID_EVENT_TYPES.join(
              ', '
            )}`
          )
        }

        if (!distId) {
          throw new Error(
            'This plugin requires "lambdaAtEdge.distributionID" to be set.'
          )
        }

        memo.push({
          fnLogicalName: this.provider.naming.getLambdaLogicalId(fnName),
          distributionID: distId,
          fnCurrentVersionOutputName: this.provider.naming.getLambdaVersionOutputLogicalId(
            fnName
          ),
          eventType: evtType
        })

        return memo
      }, [])
      .each((fn) => {
        const fnProps = template.Resources[fn.fnLogicalName].Properties

        if (fnProps && fnProps.Environment && fnProps.Environment.Variables) {
          this.serverless.cli.log(
            `Removing ${
              Object.keys(fnProps.Environment.Variables).length
            } environment variables from function "${
              fn.fnLogicalName
            }" because Lambda@Edge does not support environment variables`
          )

          delete fnProps.Environment
        }
      })
      .value()
  }

  async updateDistributionsAsNecessary(fns, dists) {
    // Need to do this sequentially otherwise AWS might throw an error like:
    //
    // ServerlessError: The request failed because it didn't meet
    // the preconditions in one or more request-header fields.
    const distKeys = Object.keys(dists)
    for (const distKey of distKeys) {
      await this.updateDistributionAsNecessary(fns, dists[distKey])
    }
  }

  async waitForDistributionDeployed(distPhysicalID) {
    let dotPrinted = false
    let running = true

    if (this._distIdIsWaiting) {
      return
    }

    const cloudfront = new this.provider.sdk.CloudFront(
      this.provider.getCredentials()
    )
    this._distIdIsWaiting = distPhysicalID

    let timeoutId
    const dotPrinter = () => {
      clearTimeout(timeoutId)
      if (running) {
        if (!dotPrinted) {
          this.serverless.cli.log(
            `Waiting for CloudFront distribution "${distPhysicalID}" to be deployed`
          )
          this.serverless.cli.log('This can take awhile.')
          dotPrinted = true
        }
        this.serverless.cli.printDot()
        timeoutId = setTimeout(dotPrinter, 2000)
      }
    }

    timeoutId = setTimeout(dotPrinter, 1000)

    return new Promise((resolve, reject) => {
      cloudfront.waitFor(
        'distributionDeployed',
        { Id: distPhysicalID },
        (err, data) => {
          clearTimeout(timeoutId)
          if (err) {
            return reject(err)
          }
          running = false
          if (dotPrinted) {
            // we have printed a dot, so clear the line
            this.serverless.cli.consoleLog('')
          }
          this.serverless.cli.log(
            `Distribution "${distPhysicalID}" is now in "${data.Distribution.Status}" state`
          )
          resolve(data)
        }
      )
    })
  }

  async updateDistributionAsNecessary(fns, dist) {
    const distID = dist.distributionID

    let data = await this.provider.request('CloudFront', 'getDistribution', {
      Id: distID
    })

    if (data.Distribution.Status !== 'Deployed') {
      data = await this.waitForDistributionDeployed(distID)
    }

    const config = data.Distribution.DistributionConfig
    const changed = this.modifyDistributionConfigIfNeeded(config, fns[distID])
    const updateParams = {
      Id: distID,
      DistributionConfig: config,
      IfMatch: data.ETag
    }

    if (changed) {
      this._alreadyWaitingForUpdates.add(distID)
      this.serverless.cli.log(
        'Updating distribution "' +
          distID +
          '" because we updated Lambda@Edge associations on it'
      )
      return this.provider
        .request('CloudFront', 'updateDistribution', updateParams)
        .then(() => this.waitForDistributionDeployed(distID))
        .then(() => {
          this.serverless.cli.log('Done updating distribution "' + distID + '"')
        })
    }

    this.serverless.cli.log(
      'The distribution is already configured with the current versions of each Lambda@Edge function it needs'
    )
  }

  modifyDistributionConfigIfNeeded(distConfig, fns) {
    let changed = this.associateFunctionsToBehavior(
      distConfig.DefaultCacheBehavior,
      fns
    )

    _.each(distConfig.CacheBehaviors.Items, (beh) => {
      const behaviorChanged = this.associateFunctionsToBehavior(beh, fns)

      changed = changed || behaviorChanged
    })

    return changed
  }

  associateFunctionsToBehavior(beh, fns) {
    let changed = false

    fns.forEach((fn) => {
      const existing = _.find(beh.LambdaFunctionAssociations.Items, {
        EventType: fn.eventType
      })

      if (!existing) {
        this.serverless.cli.log(
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
        this.serverless.cli.log(
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

  getFunctionsToAssociate() {
    const stackName = this.provider.naming.getStackName()

    return this.provider
      .request('CloudFormation', 'describeStacks', { StackName: stackName })
      .then((resp) => {
        const stack = resp.Stacks.find(
          ({ StackName }) => StackName === stackName
        )

        if (!stack) {
          throw new Error(
            `CloudFormation did not return a stack with name "${stackName}"`
          )
        }

        return this._pendingAssociations.reduce((memo, pending) => {
          const outputName = pending.fnCurrentVersionOutputName
          const output = stack.Outputs.find(
            ({ OutputKey }) => OutputKey === outputName
          )

          if (!output) {
            throw new Error(
              `Stack "${stackName}" did not have an output with name "${outputName}"`
            )
          }

          if (!memo[pending.distributionID]) {
            memo[pending.distributionID] = []
          }

          memo[pending.distributionID].push({
            eventType: pending.eventType,
            fnARN: output.OutputValue
          })

          return memo
        }, {})
      })
  }

  getDistributionPhysicalIDs() {
    return this._pendingAssociations.reduce((memo, pending) => {
      if (pending.distributionID) {
        memo[pending.fnLogicalName] = {
          distributionID: pending.distributionID
        }
      }
      return memo
    }, {})
  }
}

module.exports = ServerlessPluginExistingCloudFrontLambdaEdge
