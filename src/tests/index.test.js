const Plugin = require('../index.js')

function noop() {}

function stubServerless() {
  return {
    getProvider: function () {
      return {}
    },
    cli: {
      log: noop,
      consoleLog: noop,
      printDot: noop
    }
  }
}

describe('serverless-plugin-cloudfront-lambda-edge', function () {
  let plugin
  let functions
  let template

  beforeEach(function () {
    plugin = new Plugin(stubServerless(), {})
    plugin._provider.request = jest.fn()
    plugin._provider.naming = {
      getLambdaLogicalId: jest.fn((fnName) => {
        return 'log_id_' + fnName
      }),
      getLambdaVersionOutputLogicalId: jest.fn((fnName) => {
        return 'lambda_ver_id_' + fnName
      }),
      getStackName: jest.fn().mockReturnValue('some-stack')
    }

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
      functions: functions
    }
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
})
