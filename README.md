# Serverless Plugin: Support Lambda@Edge for Existing CloudFront Distributions
[![js-standard-style](https://img.shields.io/badge/code%20style-standard-brightgreen.svg)](http://standardjs.com)
[![Build Status](https://travis-ci.org/geoffdutton/serverless-plugin-existing-cloudfront-lambda-edge.png?branch=master)](https://travis-ci.org/geoffdutton/serverless-plugin-existing-cloudfront-lambda-edge)
[![Coverage Status](https://coveralls.io/github/geoffdutton/serverless-plugin-existing-cloudfront-lambda-edge/badge.svg?branch=master)](https://coveralls.io/github/geoffdutton/serverless-plugin-existing-cloudfront-lambda-edge?branch=master)
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
2. ~~It does not appear that you can delete Lambda@Edge functions because they are replicated.
You'll see an error like `There was an error deleting this version: Lambda was unable to delete [some function ARN] because it is a replicated function.` Here are a few links about it:~~ It appears you can now, see [Deleting Functions](#deleting-functions) below.
## How do I use it?

There are three steps:

### Install the Plugin as a Development Dependency

```bash
npm install --save-dev --save-exact serverless-plugin-existing-cloudfront-lambda-edge
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
pairs: `distribution` and `eventType`.

The `distribution` is the logical name used in your `Resources` section to
define the CloudFront distribution.

The `eventType` is one of the four Lambda@Edge event types:

   * viewer-request
   * origin-request
   * viewer-response
   * origin-response

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
         distribution: 'WebsiteDistribution'
         eventType: 'origin-request'
```

And here is an example function that would go with this Serverless template:

```js
'use strict';

module.exports = {

   // invoked by CloudFront (origin requests)
   handler: function(evt, context, cb) {
      var req = evt.Records[0].cf.request;

      if (req.uri && req.uri.length && req.uri.substring(req.uri.length - 1) === '/') {
         console.log('changing "%s" to "%s"', req.uri, req.uri + 'index.html');
         req.uri = req.uri + 'index.html';
      }

      cb(null, req);
   },

};
```

You can find more in the examples directory.

## Plugin V1
Using serverless/CloudFormation is a little finicky, but it seems to be getting better. For example, when I first forked this repo, I couldn't even manually delete the Lambda@Edge functions. Now you can. There are still some caveats such as sometimes needing to deploy twice (usually when you're changing the function signature or name).

Having said that, it's still much easier to manage than manually doing it all, assuming you have an exisiting CloudFront distribution. If not, just use [serverless-plugin-cloudfront-lambda-edge V2](https://github.com/silvermine/serverless-plugin-cloudfront-lambda-edge).



## Deleting Functions
Running the standard `sls remove` won't work because the association with the function to CloudFront. So before running `sls remove`, you need to manually remove the CloudFront event function association(s), and then wait until the CloudFront distribution is fully deployed. It seems to take 30 minutes or more.

## How do I contribute?


We genuinely appreciate external contributions. See [our extensive
documentation][contributing] on how to contribute.


## License

This software is released under the MIT license. See [the license file](LICENSE) for more
details.


[contributing]: https://github.com/silvermine/silvermine-info#contributing
