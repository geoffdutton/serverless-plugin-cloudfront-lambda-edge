# Serverless Plugin: Support Lambda@Edge for Existing CloudFront Distributions

[![Build Status](https://travis-ci.com/geoffdutton/serverless-plugin-existing-cloudfront-lambda-edge.svg?branch=master)](https://travis-ci.com/geoffdutton/serverless-plugin-existing-cloudfront-lambda-edge)
[![Coverage Status](https://coveralls.io/repos/github/geoffdutton/serverless-plugin-existing-cloudfront-lambda-edge/badge.svg?branch=master)](https://coveralls.io/github/geoffdutton/serverless-plugin-existing-cloudfront-lambda-edge?branch=master)
[![Dependency Status](https://david-dm.org/geoffdutton/serverless-plugin-existing-cloudfront-lambda-edge.svg)](https://david-dm.org/geoffdutton/serverless-plugin-existing-cloudfront-lambda-edge)
[![Dev Dependency Status](https://david-dm.org/geoffdutton/serverless-plugin-existing-cloudfront-lambda-edge/dev-status.png)](https://david-dm.org/geoffdutton/serverless-plugin-existing-cloudfront-lambda-edge#info=devDependencies&view=table)

## First things first

If you don't have an existing CloudFront distribution, just use [serverless-plugin-cloudfront-lambda-edge V2](https://github.com/silvermine/serverless-plugin-cloudfront-lambda-edge).

## What is it?

This is a plugin for the Serverless framework that adds support for associating a Lambda
function with a _existing_ CloudFront distribution to take advantage of the new Lambda@Edge features
of CloudFront.

## A Few Other Things to Keep In Mind

1. CloudFront distributions can take a long time to deploy,
   so you probably want to keep this separate from other "normal" serverless services.
2. When removing the service or deleting functions, see [Deleting Functions](#deleting-functions) below.

## How do I use it?

There are three steps:

### Install the Plugin as a Development Dependency

```bash
npm install --save-dev serverless-plugin-existing-cloudfront-lambda-edge
```

### Telling Serverless to Use the Plugin

Simply add this plugin to the list of plugins in your `serverless.yml` file:

```yml
plugins:
  - serverless-plugin-existing-cloudfront-lambda-edge
```

### Configuring Functions to Associate With CloudFront Distributions

Also in your `serverless.yml` file, you will modify your function definitions
to include a `lambdaAtEdge` property. That object will contain two key/value
pairs: `distributionID` and `eventType`.

The `eventType` is one of the four Lambda@Edge event types:

- viewer-request
- origin-request
- viewer-response
- origin-response

For example:

```yml
functions:
  directoryRootOriginRequestRewriter:
    name: '${self:custom.objectPrefix}-origin-request'
    handler: src/DirectoryRootOriginRequestRewriteHandler.handler
    memorySize: 128
    timeout: 1
    lambdaAtEdge:
      distributionID: OIJOI2332OLIN
      eventType: 'origin-request'
```

And here is an example function that would go with this Serverless template:

```js
module.exports = {
  // Invoked by CloudFront (origin requests)
  async handler(event, context) {
    // When first testing, I recommend to log these
    console.log('event', JSON.stringify(event))
    console.log('context', JSON.stringify(context))
    const req = event.Records[0].cf.request

    if (
      req.uri &&
      req.uri.length &&
      req.uri.substring(req.uri.length - 1) === '/'
    ) {
      console.log('changing "%s" to "%s"', req.uri, req.uri + 'index.html')
      req.uri = req.uri + 'index.html'
    }

    return req
  }
}
```

You can find more in the [examples](examples) directory.

## Plugin V2

Using serverless/CloudFormation is a little finicky, but it seems to be getting better. For example, when I first forked this repo, I couldn't even manually delete the Lambda@Edge functions. Now you can. There are still some caveats such as sometimes needing to deploy twice (usually when you're changing the function signature or name).

Having said that, it's still much easier to manage than manually doing it all, assuming you have an existing CloudFront distribution. If not, just use [serverless-plugin-cloudfront-lambda-edge V2](https://github.com/silvermine/serverless-plugin-cloudfront-lambda-edge).

## Logs

Given that Lambda@Edge can run in any region that CloudFront operates, the execution logs can be scattered throughout CloudWatch regions. Nothing will be logged to the expected CloudWatch logs created by the Serverless framework.

## Deleting Functions

Running the standard `sls remove` won't work because the association with the function to CloudFront. So before running `sls remove`, you need to manually remove the CloudFront event function association(s), and then wait until the CloudFront distribution is fully deployed. See the full [AWS Documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-edge-delete-replicas.html) for more details.

Lastly, even when you follow the steps above, and your distribution is fully deployed, it can still take another hour or two before you can successfully delete the lambda function(s).

## How do I contribute?

Feel free to open an issue and/or create a pull request.

## License

This software is released under the MIT license. See [the license file](LICENSE) for more
details.

## Credits

- [Jeremy Thomerson / Silvermine](https://github.com/silvermine/serverless-plugin-cloudfront-lambda-edge)
