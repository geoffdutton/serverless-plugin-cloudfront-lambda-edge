const Plugin = require('../index.js')

function stubServerless() {
  return {
    getProvider: function () {
      return {
        request: jest.fn(),
        naming: {
          getLambdaLogicalId: jest.fn((fnName) => {
            return 'log_id_' + fnName
          }),
          getLambdaVersionOutputLogicalId: jest.fn((fnName) => {
            return 'lambda_ver_id_' + fnName
          }),
          getStackName: jest.fn().mockReturnValue('some-stack')
        }
      }
    },
    cli: {
      log: jest.fn(),
      consoleLog: jest.fn(),
      printDot: jest.fn()
    }
  }
}

describe('serverless-plugin-cloudfront-lambda-edge', function () {
  let plugin
  let functions
  let template
  let stubbedSls

  beforeEach(function () {
    plugin = new Plugin(stubServerless(), {})

    functions = {
      someFn: {
        lambdaAtEdge: {
          distribution: 'WebDist',
          distributionID: '123ABC',
          eventType: 'viewer-request'
        }
      }
    }

    template = {
      Resources: {
        log_id_someFn: {
          Properties: {}
        }
      }
    }

    plugin._serverless.service = {
      functions: functions,
      provider: {
        compiledCloudFormationTemplate: {
          Resources: {
            IamRoleLambdaExecution: {
              Properties: {
                AssumeRolePolicyDocument: {
                  Statement: [
                    {
                      Principal: {
                        Service: ['lambda.amazonaws.com']
                      }
                    }
                  ]
                },
                Policies: [
                  {
                    PolicyDocument: {
                      Statement: []
                    }
                  }
                ]
              }
            }
          }
        }
      }
    }

    stubbedSls = plugin._serverless
  })

  describe('_onPackageCustomResources', () => {
    beforeEach(() => {
      plugin._modifyLambdaFunctions = jest.fn()
    })

    it('warns if not IamRoleLambdaExecution', () => {
      stubbedSls.service.provider.compiledCloudFormationTemplate.Resources = {}
      plugin._onPackageCustomResources()
      expect(plugin._modifyLambdaFunctions).toHaveBeenCalledWith(
        stubbedSls.service.functions,
        {
          Resources: {}
        }
      )
      expect(stubbedSls.cli.log).toHaveBeenCalledWith(
        'WARNING: no IAM role for Lambda execution found - can not modify assume role policy'
      )
    })

    it('adds edge lambda to IamRoleLambdaExecution if not there', () => {
      plugin._onPackageCustomResources()
      const cpldTmpl =
        stubbedSls.service.provider.compiledCloudFormationTemplate.Resources
      expect(
        cpldTmpl.IamRoleLambdaExecution.Properties.AssumeRolePolicyDocument
          .Statement[0].Principal.Service
      ).toEqual(['lambda.amazonaws.com', 'edgelambda.amazonaws.com'])

      expect(
        cpldTmpl.IamRoleLambdaExecution.Properties.Policies[0].PolicyDocument
          .Statement
      ).toContainEqual({
        Effect: 'Allow',
        Action: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogStreams'
        ],
        Resource: 'arn:aws:logs:*:*:*'
      })

      expect(stubbedSls.cli.log).toHaveBeenCalledWith(
        'Updated Lambda assume role policy to allow Lambda@Edge to assume the role'
      )

      expect(stubbedSls.cli.log).not.toHaveBeenCalledWith(
        'WARNING: was unable to update the Lambda assume role policy to allow Lambda@Edge to assume the role'
      )
    })

    it('warns if policy is not updated', () => {
      const cpldTmpl =
        stubbedSls.service.provider.compiledCloudFormationTemplate.Resources
      cpldTmpl.IamRoleLambdaExecution.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service = []

      plugin._onPackageCustomResources()

      expect(
        cpldTmpl.IamRoleLambdaExecution.Properties.AssumeRolePolicyDocument
          .Statement[0].Principal.Service
      ).toEqual([])

      expect(stubbedSls.cli.log).not.toHaveBeenCalledWith(
        'Updated Lambda assume role policy to allow Lambda@Edge to assume the role'
      )

      expect(stubbedSls.cli.log).toHaveBeenCalledWith(
        'WARNING: was unable to update the Lambda assume role policy to allow Lambda@Edge to assume the role'
      )
    })
  })

  describe('_modifyLambdaFunctions()', function () {
    it('does nothing if lambdaAtEdge doesnt exist', function () {
      functions = {
        someFn: {}
      }
      plugin._modifyLambdaFunctions(functions, template)
      expect(plugin._pendingAssociations).toEqual([])
    })

    it('requires a valid event type', function () {
      functions.someFn.lambdaAtEdge.eventType = 'wrong-event'
      expect(() => plugin._modifyLambdaFunctions(functions, template)).toThrow(
        /"wrong-event" is not a valid event type, must be one of/
      )
    })

    it('requires a valid distribution', function () {
      functions.someFn.lambdaAtEdge.distributionID = null
      functions.someFn.lambdaAtEdge.distribution = 'not-existing'
      expect(() => plugin._modifyLambdaFunctions(functions, template)).toThrow(
        /Could not find resource with logical name "not-existing" or there is no distributionID set/
      )
    })

    it('requires a distribution even with distributionID', function () {
      functions.someFn.lambdaAtEdge.distribution = null
      expect(() => plugin._modifyLambdaFunctions(functions, template)).toThrow(
        /Distribution ID "123ABC" requires a distribution to be set/
      )
    })

    it('requires resource type to be AWS::CloudFront::Distribution', function () {
      functions.someFn.lambdaAtEdge.distributionID = null
      functions.someFn.lambdaAtEdge.distribution = 'SomeRes'

      template.Resources.SomeRes = { Type: 'wrongtype' }

      expect(() => plugin._modifyLambdaFunctions(functions, template)).toThrow(
        /Resource with logical name "SomeRes" is not type AWS::CloudFront::Distribution/
      )
    })

    it('adds valid pending association', function () {
      functions.someFn.lambdaAtEdge.distributionID = null
      template.Resources.WebDist = { Type: 'AWS::CloudFront::Distribution' }

      plugin._modifyLambdaFunctions(functions, template)

      expect(plugin._pendingAssociations[0]).toEqual({
        fnLogicalName: 'log_id_someFn',
        distLogicalName: 'WebDist',
        distributionID: null,
        fnCurrentVersionOutputName: 'lambda_ver_id_someFn',
        eventType: 'viewer-request'
      })

      expect(plugin._provider.naming.getLambdaLogicalId).toHaveBeenCalledWith(
        'someFn'
      )

      expect(
        plugin._provider.naming.getLambdaVersionOutputLogicalId
      ).toHaveBeenCalledWith('someFn')
    })

    it('accepts a distribution Id in place of a Resource distribution', function () {
      functions.someFn.lambdaAtEdge.distribution = 'ExistingWebDist'
      plugin._modifyLambdaFunctions(functions, template)

      expect(plugin._pendingAssociations[0]).toEqual({
        fnLogicalName: 'log_id_someFn',
        distLogicalName: 'ExistingWebDist',
        distributionID: '123ABC',
        fnCurrentVersionOutputName: 'lambda_ver_id_someFn',
        eventType: 'viewer-request'
      })
    })
  })

  describe('_getDistributionPhysicalIDs()', function () {
    it('does not call describeStackResource if all pending contain distributionIDs', function () {
      plugin._pendingAssociations = [
        {
          fnLogicalName: 'some-fn1',
          distLogicalName: 'WebDist1',
          distributionID: 'ABC'
        },
        {
          fnLogicalName: 'some-fn2',
          distLogicalName: 'WebDist2',
          distributionID: 'DEF'
        }
      ]
      return plugin._getDistributionPhysicalIDs().then(function (dists) {
        expect(dists).toEqual({
          'some-fn1': {
            distLogicalName: 'WebDist1',
            distributionID: 'ABC'
          },
          'some-fn2': {
            distLogicalName: 'WebDist2',
            distributionID: 'DEF'
          }
        })
        expect(plugin._provider.request).not.toHaveBeenCalled()
      })
    })

    it('gets physical id from stack', function () {
      plugin._pendingAssociations = [
        {
          fnLogicalName: 'some-fn1',
          distLogicalName: 'WebDist',
          distributionID: null
        }
      ]

      plugin._provider.request.mockResolvedValueOnce({
        StackResources: [
          {
            LogicalResourceId: 'WebDist',
            PhysicalResourceId: 'ABC123'
          }
        ]
      })

      // plugin._provider.request.withArgs('CloudFormation', 'describeStackResources', { StackName: 'some-stack' })
      //   .resolves()

      return plugin._getDistributionPhysicalIDs().then(function (dists) {
        expect(dists).toEqual({
          'some-fn1': {
            distLogicalName: 'WebDist',
            distributionID: 'ABC123'
          }
        })

        expect(plugin._provider.request).toHaveBeenCalledWith(
          'CloudFormation',
          'describeStackResources',
          { StackName: 'some-stack' }
        )
      })
    })

    it('does not call describeStackResource if same dist logical name and dist id are the same for all pending associations', function () {
      plugin._pendingAssociations = [
        {
          fnLogicalName: 'some-fn1',
          distLogicalName: 'WebDist1',
          distributionID: 'ABC'
        },
        {
          fnLogicalName: 'some-fn2',
          distLogicalName: 'WebDist1',
          distributionID: 'ABC'
        }
      ]
      return plugin._getDistributionPhysicalIDs().then(function (dists) {
        expect(dists).toEqual({
          'some-fn1': {
            distLogicalName: 'WebDist1',
            distributionID: 'ABC'
          },
          'some-fn2': {
            distLogicalName: 'WebDist1',
            distributionID: 'ABC'
          }
        })
        expect(plugin._provider.request).not.toHaveBeenCalled()
      })
    })
  })

  describe('_onBeforeDeployFinalize', () => {
    beforeEach(() => {
      plugin._pendingAssociations = []
      plugin._getFunctionsToAssociate = jest.fn().mockResolvedValue({
        WebDist1: [
          {
            eventType: 'viewer-request',
            fnARN: 'web-dist1-arn'
          }
        ]
      })

      plugin._getDistributionPhysicalIDs = jest.fn().mockResolvedValue({
        'some-fn1': {
          distLogicalName: 'WebDist1',
          distributionID: 'ABC'
        }
      })

      plugin._updateDistributionsAsNecessary = jest.fn().mockResolvedValue()
    })

    it('returns if no pending associations', async () => {
      await plugin._onBeforeDeployFinalize()
      expect(plugin._getFunctionsToAssociate).not.toHaveBeenCalled()
    })

    it('updates pending associations', async () => {
      plugin._pendingAssociations = [
        {
          fnLogicalName: 'some-fn1',
          distLogicalName: 'WebDist1',
          distributionID: 'ABC'
        }
      ]
      await plugin._onBeforeDeployFinalize()

      expect(plugin._getFunctionsToAssociate).toHaveBeenCalledTimes(1)
      expect(plugin._getDistributionPhysicalIDs).toHaveBeenCalledTimes(1)
      expect(plugin._updateDistributionsAsNecessary).toHaveBeenCalledWith(
        {
          WebDist1: [
            {
              eventType: 'viewer-request',
              fnARN: 'web-dist1-arn'
            }
          ]
        },
        {
          'some-fn1': {
            distLogicalName: 'WebDist1',
            distributionID: 'ABC'
          }
        }
      )
    })
  })

  describe('_updateDistributionAsNecessary', () => {
    let _dist
    beforeEach(() => {
      _dist = {
        distLogicalName: 'WebDist1',
        distributionID: '123ABC'
      }
      functions = {
        WebDist1: [
          {
            eventType: 'viewer-request',
            fnARN: 'web-dist1-arn'
          }
        ]
      }
      plugin._provider.request
        .mockResolvedValueOnce({
          Distribution: {
            Status: 'Deploying'
          }
        })
        .mockResolvedValueOnce()
      plugin._modifyDistributionConfigIfNeeded = jest.fn().mockReturnValue(true)
      plugin._waitForDistributionDeployed = jest.fn().mockResolvedValue({
        Distribution: {
          Status: 'Deployed',
          DistributionConfig: {
            Dist: 'config'
          }
        },
        ETag: 'etag-1'
      })
    })

    it('update distribution if config changed', async () => {
      await plugin._updateDistributionAsNecessary(functions, _dist)
      expect(plugin._provider.request).toHaveBeenCalledWith(
        'CloudFront',
        'getDistribution',
        {
          Id: _dist.distributionID
        }
      )

      expect(plugin._waitForDistributionDeployed).toHaveBeenCalledWith(
        _dist.distributionID,
        _dist.distLogicalName
      )

      expect(plugin._alreadyWaitingForUpdates).toContain(
        _dist.distributionID + _dist.distLogicalName
      )

      expect(plugin._provider.request).toHaveBeenCalledWith(
        'CloudFront',
        'updateDistribution',
        {
          Id: _dist.distributionID,
          DistributionConfig: {
            Dist: 'config'
          },
          IfMatch: 'etag-1'
        }
      )

      expect(plugin._waitForDistributionDeployed).toHaveBeenCalledTimes(2)
    })

    it('skips updates if not changed', async () => {
      plugin._modifyDistributionConfigIfNeeded.mockReturnValue(false)
      plugin._provider.request = jest.fn().mockResolvedValueOnce({
        Distribution: {
          Status: 'Deployed'
        }
      })
      await plugin._updateDistributionAsNecessary(functions, _dist)
      expect(plugin._provider.request).toHaveBeenCalledWith(
        'CloudFront',
        'getDistribution',
        {
          Id: _dist.distributionID
        }
      )

      expect(plugin._waitForDistributionDeployed).not.toHaveBeenCalled()
      expect(plugin._provider.request).toHaveBeenCalledTimes(1)
    })
  })

  describe('_waitForDistributionDeployed', () => {})
})
