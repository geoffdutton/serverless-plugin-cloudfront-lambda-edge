const Plugin = require('../index.js')

function stubServerless() {
  return {
    getProvider() {
      return {
        getCredentials: jest.fn(() => ({ aws: 'creds' })),
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

describe('serverless-plugin-existing-cloudfront-lambda-edge', function () {
  let plugin
  let functions
  let template
  let stubbedSls

  beforeEach(function () {
    plugin = new Plugin(stubServerless(), {})

    functions = {
      someFn: {
        lambdaAtEdge: {
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

    plugin.serverless.service = {
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

    stubbedSls = plugin.serverless
  })

  it('throws error if provider aws does not exist', () => {
    const _stub = stubServerless()
    _stub.getProvider = () => null
    expect(() => new Plugin(_stub, {})).toThrow(
      'This plugin must be used with AWS.'
    )
  })

  describe('onPackageCustomResources', () => {
    beforeEach(() => {
      plugin.modifyLambdaFunctions = jest.fn()
    })

    it('warns if not IamRoleLambdaExecution', () => {
      stubbedSls.service.provider.compiledCloudFormationTemplate.Resources = {}
      plugin.onPackageCustomResources()
      expect(plugin.modifyLambdaFunctions).toHaveBeenCalledWith(
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
      plugin.onPackageCustomResources()
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

      plugin.onPackageCustomResources()

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

  describe('modifyLambdaFunctions()', function () {
    it('does nothing if lambdaAtEdge doesnt exist', function () {
      functions = {
        someFn: {}
      }
      plugin.modifyLambdaFunctions(functions, template)
      expect(plugin._pendingAssociations).toEqual([])
    })

    it('requires a valid event type', function () {
      functions.someFn.lambdaAtEdge.eventType = 'wrong-event'
      expect(() => plugin.modifyLambdaFunctions(functions, template)).toThrow(
        /"wrong-event" is not a valid event type, must be one of/
      )
    })

    it('requires a distributionID', function () {
      functions.someFn.lambdaAtEdge.distributionID = null
      expect(() => plugin.modifyLambdaFunctions(functions, template)).toThrow(
        'This plugin requires "lambdaAtEdge.distributionID" to be set.'
      )
    })

    it('adds valid pending association', function () {
      functions.someFn.lambdaAtEdge.distributionID = 'DDD32FWEF'

      plugin.modifyLambdaFunctions(functions, template)

      expect(plugin._pendingAssociations[0]).toEqual({
        fnLogicalName: 'log_id_someFn',
        distributionID: 'DDD32FWEF',
        fnCurrentVersionOutputName: 'lambda_ver_id_someFn',
        eventType: 'viewer-request'
      })

      expect(plugin.provider.naming.getLambdaLogicalId).toHaveBeenCalledWith(
        'someFn'
      )

      expect(
        plugin.provider.naming.getLambdaVersionOutputLogicalId
      ).toHaveBeenCalledWith('someFn')
    })

    it('accepts a distribution Id in place of a Resource distribution', function () {
      plugin.modifyLambdaFunctions(functions, template)

      expect(plugin._pendingAssociations[0]).toEqual({
        fnLogicalName: 'log_id_someFn',
        distributionID: '123ABC',
        fnCurrentVersionOutputName: 'lambda_ver_id_someFn',
        eventType: 'viewer-request'
      })
    })

    it('removes and warns about environment variables', () => {
      template.Resources.log_id_someFn.Properties.Environment = {
        Variables: {
          MY_FIRST_ENV_VAR: 'yay'
        }
      }
      plugin.modifyLambdaFunctions(functions, template)
      expect(
        template.Resources.log_id_someFn.Properties.Environment
      ).toBeUndefined()
      expect(stubbedSls.cli.log).toHaveBeenCalledWith(
        expect.stringContaining(
          'Removing 1 environment variables from function "'
        )
      )
    })
  })

  describe('getDistributionPhysicalIDs()', function () {
    it('adds distribution id by logical function name', () => {
      plugin._pendingAssociations = [
        {
          fnLogicalName: 'some-fn1',
          distributionID: 'ABC'
        },
        {
          fnLogicalName: 'some-fn2',
          distributionID: 'DEF'
        }
      ]

      expect(plugin.getDistributionPhysicalIDs()).toEqual({
        'some-fn1': {
          distributionID: 'ABC'
        },
        'some-fn2': {
          distributionID: 'DEF'
        }
      })
      expect(plugin.provider.request).not.toHaveBeenCalled()
    })

    it('returns an empty object if no distributionID', () => {
      plugin._pendingAssociations = [
        {
          fnLogicalName: 'some-fn1'
        }
      ]
      expect(plugin.getDistributionPhysicalIDs()).toEqual({})
    })
  })

  describe('onBeforeDeployFinalize', () => {
    beforeEach(() => {
      plugin._pendingAssociations = []
      plugin.getFunctionsToAssociate = jest.fn().mockResolvedValue({
        ABC444: [
          {
            eventType: 'viewer-request',
            fnARN: 'some-fn1-arn'
          }
        ]
      })

      plugin.getDistributionPhysicalIDs = jest.fn().mockResolvedValue({
        'some-fn1': {
          distributionID: 'ABC444'
        }
      })

      plugin.updateDistributionsAsNecessary = jest.fn().mockResolvedValue()
    })

    it('returns if no pending associations', async () => {
      await plugin.onBeforeDeployFinalize()
      expect(plugin.getFunctionsToAssociate).not.toHaveBeenCalled()
    })

    it('updates pending associations', async () => {
      plugin._pendingAssociations = [
        {
          fnLogicalName: 'some-fn1',
          distributionID: 'ABC444'
        }
      ]
      await plugin.onBeforeDeployFinalize()

      expect(plugin.getFunctionsToAssociate).toHaveBeenCalledTimes(1)
      expect(plugin.getDistributionPhysicalIDs).toHaveBeenCalledTimes(1)
      expect(plugin.updateDistributionsAsNecessary).toHaveBeenCalledWith(
        {
          ABC444: [
            {
              eventType: 'viewer-request',
              fnARN: 'some-fn1-arn'
            }
          ]
        },
        {
          'some-fn1': {
            distributionID: 'ABC444'
          }
        }
      )
    })

    it('pluralizes message', async () => {
      plugin._pendingAssociations = [
        {
          fnLogicalName: 'some-fn1',
          distributionID: 'ABC'
        },
        {
          fnLogicalName: 'some-fn2',
          distributionID: 'ABC'
        }
      ]
      await plugin.onBeforeDeployFinalize()
      expect(stubbedSls.cli.log).toHaveBeenCalledWith(
        'Checking to see if 2 functions need to be associated to CloudFront.'
      )
    })

    /// making sure it returns a promise
    it('resolves undefined if no pending associations', () => {
      plugin._pendingAssociations = []
      return plugin.onBeforeDeployFinalize().then((res) => {
        expect(res).toBeUndefined()
        expect(plugin.getFunctionsToAssociate).not.toHaveBeenCalled()
        expect(plugin.getDistributionPhysicalIDs).not.toHaveBeenCalled()
      })
    })
  })

  describe('updateDistributionAsNecessary', () => {
    let _dist
    beforeEach(() => {
      _dist = {
        distributionID: '123ABC'
      }
      functions = {
        '123ABC': [
          {
            eventType: 'viewer-request',
            fnARN: 'web-dist1-arn'
          }
        ]
      }
      plugin.provider.request
        .mockResolvedValueOnce({
          Distribution: {
            Status: 'Deploying'
          }
        })
        .mockResolvedValueOnce()
      plugin.modifyDistributionConfigIfNeeded = jest.fn().mockReturnValue(true)
      plugin.waitForDistributionDeployed = jest.fn().mockResolvedValue({
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
      await plugin.updateDistributionAsNecessary(functions, _dist)
      expect(plugin.provider.request).toHaveBeenCalledWith(
        'CloudFront',
        'getDistribution',
        {
          Id: _dist.distributionID
        }
      )

      expect(plugin.waitForDistributionDeployed).toHaveBeenCalledWith(
        _dist.distributionID
      )

      expect(plugin._alreadyWaitingForUpdates).toContain(_dist.distributionID)

      expect(plugin.provider.request).toHaveBeenCalledWith(
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

      expect(plugin.waitForDistributionDeployed).toHaveBeenCalledTimes(2)
    })

    it('skips updates if not changed', async () => {
      plugin.modifyDistributionConfigIfNeeded.mockReturnValue(false)
      plugin.provider.request = jest.fn().mockResolvedValueOnce({
        Distribution: {
          Status: 'Deployed'
        }
      })
      await plugin.updateDistributionAsNecessary(functions, _dist)
      expect(plugin.provider.request).toHaveBeenCalledWith(
        'CloudFront',
        'getDistribution',
        {
          Id: _dist.distributionID
        }
      )

      expect(plugin.waitForDistributionDeployed).not.toHaveBeenCalled()
      expect(plugin.provider.request).toHaveBeenCalledTimes(1)
    })
  })

  describe('waitForDistributionDeployed', () => {
    let cfWaitForStub
    let cloudFrontStub
    let distPhysicalID

    beforeEach(() => {
      jest.useFakeTimers()
      distPhysicalID = 'success-dist-id'

      cfWaitForStub = jest.fn()

      cloudFrontStub = jest.fn().mockImplementation(() => {
        return {
          waitFor: jest.fn((evName, { Id }, cb) => {
            cfWaitForStub(evName, { Id }, cb)
            cloudFrontStub.__callback = cb
          })
        }
      })

      plugin.provider.sdk = {
        CloudFront: cloudFrontStub
      }
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('returns if already waiting', async () => {
      plugin._distIdIsWaiting = distPhysicalID
      expect(
        await plugin.waitForDistributionDeployed(distPhysicalID)
      ).toBeUndefined()
      expect(cloudFrontStub).not.toHaveBeenCalled()
      expect(stubbedSls.cli.log).not.toHaveBeenCalled()
    })

    it('prints out status', async () => {
      const prom = plugin.waitForDistributionDeployed(distPhysicalID)
      expect(cloudFrontStub).toHaveBeenCalledWith({ aws: 'creds' })
      jest.advanceTimersByTime(1000)
      expect(stubbedSls.cli.log).toHaveBeenCalledWith(
        `Waiting for CloudFront distribution "${distPhysicalID}" to be deployed`
      )
      expect(stubbedSls.cli.log).toHaveBeenCalledTimes(2)
      expect(stubbedSls.cli.printDot).toHaveBeenCalledTimes(1)

      jest.advanceTimersByTime(2000)
      expect(stubbedSls.cli.log).toHaveBeenCalledTimes(2)
      expect(stubbedSls.cli.printDot).toHaveBeenCalledTimes(2)

      cloudFrontStub.__callback(null, {
        Distribution: {
          Status: 'Deployed'
        }
      })

      expect(await prom).toEqual({
        Distribution: {
          Status: 'Deployed'
        }
      })
      expect(cfWaitForStub).toHaveBeenCalledWith(
        'distributionDeployed',
        { Id: distPhysicalID },
        cloudFrontStub.__callback
      )

      expect(stubbedSls.cli.consoleLog).toHaveBeenCalledWith('')

      jest.runAllTimers()
      expect(stubbedSls.cli.printDot).toHaveBeenCalledTimes(2)
    })

    it('rejects on error', async () => {
      const prom = plugin.waitForDistributionDeployed(distPhysicalID)

      cloudFrontStub.__callback(new Error('AWS Timeout'))
      await expect(prom).rejects.toThrow('AWS Timeout')
    })
  })

  describe('updateDistributionsAsNecessary', () => {
    beforeEach(() => {
      plugin.updateDistributionAsNecessary = jest.fn().mockResolvedValue()
    })

    it('updates each distribution sequentially', async () => {
      const _dists = {
        fn1: {
          distributionID: 'FGE444',
          fnARN: 'fn2-arn'
        },
        fn2: {
          distributionID: 'FGE444',
          fnARN: 'fn2-arn'
        }
      }
      await plugin.updateDistributionsAsNecessary(functions, _dists)
      expect(plugin.updateDistributionAsNecessary).toHaveBeenCalledTimes(2)
      expect(plugin.updateDistributionAsNecessary).toHaveBeenCalledWith(
        functions,
        _dists.fn1
      )
      expect(plugin.updateDistributionAsNecessary).toHaveBeenCalledWith(
        functions,
        _dists.fn2
      )
    })
  })

  describe('getFunctionsToAssociate', () => {
    beforeEach(() => {
      plugin.provider.request = jest.fn(async (awsSvc, awsSvcMethod, args) => {
        if (awsSvc === 'CloudFormation' && awsSvcMethod === 'describeStacks') {
          if (args.StackName === 'some-stack') {
            return {
              Stacks: [
                {
                  StackName: 'some-stack',
                  Outputs: [
                    {
                      OutputKey: 'LambdaFnArn',
                      OutputValue: 'aws:lambda:34234:arn:fn'
                    },
                    {
                      OutputKey: 'LambdaFn2Arn',
                      OutputValue: 'aws:lambda:34234:arn:fn2'
                    }
                  ]
                }
              ]
            }
          } else if (args.StackName === 'stack-missing-output') {
            return {
              Stacks: [
                {
                  StackName: 'stack-missing-output',
                  Outputs: [
                    {
                      OutputKey: 'LambdaFnArn',
                      OutputValue: 'aws:lambda:34234:arn:fn'
                    }
                  ]
                }
              ]
            }
          }
        }

        return {
          Stacks: []
        }
      })
    })

    it('resolves object with fnARN and eventType', async () => {
      plugin._pendingAssociations = [
        {
          fnCurrentVersionOutputName: 'LambdaFnArn',
          fnLogicalName: 'a-fn1',
          distributionID: 'DEFFED2222',
          eventType: 'viewer-request'
        },
        {
          fnCurrentVersionOutputName: 'LambdaFn2Arn',
          fnLogicalName: 'a-fn2',
          distributionID: 'DEFFED2222',
          eventType: 'viewer-response'
        }
      ]

      await expect(plugin.getFunctionsToAssociate()).resolves.toEqual({
        DEFFED2222: [
          {
            eventType: 'viewer-request',
            fnARN: 'aws:lambda:34234:arn:fn'
          },
          {
            eventType: 'viewer-response',
            fnARN: 'aws:lambda:34234:arn:fn2'
          }
        ]
      })
    })

    it('rejects if stack not found', async () => {
      plugin.provider.naming.getStackName.mockReturnValue('another-stack')
      await expect(plugin.getFunctionsToAssociate()).rejects.toThrow(
        `CloudFormation did not return a stack with name "another-stack"`
      )
    })

    it('rejects if output not found in stack', async () => {
      plugin._pendingAssociations = [
        {
          fnCurrentVersionOutputName: 'LambdaFnArnMissing',
          fnLogicalName: 'a-fn1',
          distributionID: 'DEFFED2222',
          eventType: 'viewer-request'
        },
        {
          fnCurrentVersionOutputName: 'LambdaFn2Arn',
          fnLogicalName: 'a-fn2',
          distributionID: 'DEFFED2222',
          eventType: 'viewer-response'
        }
      ]
      plugin.provider.naming.getStackName.mockReturnValue(
        'stack-missing-output'
      )
      await expect(plugin.getFunctionsToAssociate()).rejects.toThrow(
        `Stack "stack-missing-output" did not have an output with name "LambdaFnArnMissing"`
      )
    })
  })

  describe('modifyDistributionConfigIfNeeded', () => {
    let distConfig
    let moddedFns
    beforeEach(() => {
      // This is generated by `getFunctionsToAssociate()`
      moddedFns = [
        {
          eventType: 'viewer-request',
          fnARN: 'arn-fn1'
        },
        {
          eventType: 'origin-response',
          fnARN: 'arn-fn2'
        },
        {
          eventType: 'viewer-response',
          fnARN: 'arn-fn3'
        }
      ]
      distConfig = {
        CacheBehaviors: {
          Items: []
        },
        DefaultCacheBehavior: {
          LambdaFunctionAssociations: {
            Items: [
              {
                EventType: 'origin-response',
                LambdaFunctionARN: 'arn-old-fn2'
              },
              {
                EventType: 'viewer-response',
                LambdaFunctionARN: 'arn-fn3'
              }
            ]
          }
        }
      }
    })

    describe('returns true', () => {
      it('modifies default cache behavior', () => {
        expect(
          plugin.modifyDistributionConfigIfNeeded(distConfig, moddedFns)
        ).toBe(true)

        expect(
          distConfig.DefaultCacheBehavior.LambdaFunctionAssociations.Items
        ).toEqual([
          {
            EventType: 'origin-response',
            LambdaFunctionARN: 'arn-fn2'
          },
          {
            EventType: 'viewer-response',
            LambdaFunctionARN: 'arn-fn3'
          },
          {
            EventType: 'viewer-request',
            LambdaFunctionARN: 'arn-fn1'
          }
        ])
      })

      it('modifies other cache behaviors', () => {
        moddedFns = [
          {
            eventType: 'viewer-request',
            fnARN: 'arn-fn1'
          },
          {
            eventType: 'origin-response',
            fnARN: 'arn-fn2'
          }
        ]
        distConfig = {
          CacheBehaviors: {
            Items: [
              {
                LambdaFunctionAssociations: {
                  Items: []
                }
              }
            ]
          },
          DefaultCacheBehavior: {
            LambdaFunctionAssociations: {
              Items: [
                {
                  EventType: 'origin-response',
                  LambdaFunctionARN: 'arn-fn2'
                },
                {
                  EventType: 'viewer-request',
                  LambdaFunctionARN: 'arn-fn1'
                }
              ]
            }
          }
        }
        expect(
          plugin.modifyDistributionConfigIfNeeded(distConfig, moddedFns)
        ).toBe(true)

        expect(
          distConfig.DefaultCacheBehavior.LambdaFunctionAssociations.Items
        ).toEqual([
          {
            EventType: 'origin-response',
            LambdaFunctionARN: 'arn-fn2'
          },
          {
            EventType: 'viewer-request',
            LambdaFunctionARN: 'arn-fn1'
          }
        ])

        expect(
          distConfig.CacheBehaviors.Items[0].LambdaFunctionAssociations.Items
        ).toEqual([
          {
            EventType: 'viewer-request',
            LambdaFunctionARN: 'arn-fn1'
          },
          {
            EventType: 'origin-response',
            LambdaFunctionARN: 'arn-fn2'
          }
        ])
      })
    })

    it('returns false if no changes', () => {
      moddedFns = [
        {
          eventType: 'viewer-request',
          fnARN: 'arn-fn1'
        }
      ]
      distConfig = {
        CacheBehaviors: {
          Items: [
            {
              LambdaFunctionAssociations: {
                Items: [
                  {
                    EventType: 'viewer-request',
                    LambdaFunctionARN: 'arn-fn1'
                  }
                ]
              }
            }
          ]
        },
        DefaultCacheBehavior: {
          LambdaFunctionAssociations: {
            Items: [
              {
                EventType: 'viewer-request',
                LambdaFunctionARN: 'arn-fn1'
              }
            ]
          }
        }
      }

      expect(
        plugin.modifyDistributionConfigIfNeeded(distConfig, moddedFns)
      ).toBe(false)
    })
  })
})
