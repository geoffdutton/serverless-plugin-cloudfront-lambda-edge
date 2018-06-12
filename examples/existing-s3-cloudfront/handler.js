/* eslint-disable no-console */

module.exports = {

  // invoked by CloudFront (origin response)
  handler: function (event, context, cb) {
    const response = event.Records[0].cf.response
    const headers = response.headers
    const requestHeaders = event.Records[0].cf.request.headers
    const countryCode = requestHeaders['cloudfront-viewer-country'][0].value

    console.log(JSON.stringify(event, null, 2))
    headers['x-serverless-example'] = [
      {
        key: 'X-Serverless-Example',
        value: 'Existing s3 bucket and clodfront'
      }
    ]

    headers['x-country-code'] = [
      {
        key: 'X-Country-Code',
        value: countryCode
      }
    ]

    // Fun fact! You can't set cookies from the origin response
    // headers['set-cookie'] = [
    //    {
    //       key: 'Set-Cookie',
    //       value: 'x-serverless-example=val; Path=/',
    //    },
    // ];

    cb(null, response)
  },

  // invoked by CloudFront (viewer response)
  cookieSetter: function (event, context, cb) {
    const response = event.Records[0].cf.response
    const headers = response.headers

    console.log(JSON.stringify(event, null, 2))

    const countryCode = (headers['x-country-code'] || [{}])[0].value || 'NA'
    headers['set-cookie'] = [
      {
        key: 'Set-Cookie',
        value: `countryCode=${countryCode}; Path=/`
      }
    ]

    cb(null, response)
  }
}
