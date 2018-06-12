'use strict';
/* eslint-disable no-console */

module.exports = {

  // invoked by CloudFront (origin response)
   handler: function(event, context, cb) {
      var response = event.Records[0].cf.response,
          headers = response.headers;

      headers['x-serverless-example'] = [
         {
            key: 'X-Serverless-Example',
            value: 'Existing s3 bucket and clodfront',
         },
      ];

      // Fun fact! You can't set cookies from the origin response
      // headers['set-cookie'] = [
      //    {
      //       key: 'Set-Cookie',
      //       value: 'x-serverless-example=val; Path=/',
      //    },
      // ];

      cb(null, response);
   },

   // invoked by CloudFront (viewer response)
   cookieSetter: function(event, context, cb) {
      var response = event.Records[0].cf.response,
          headers = response.headers;

      headers['set-cookie'] = [
         {
            key: 'Set-Cookie',
            value: 'some=cookie; Path=/',
         },
      ];

      cb(null, response);
   },
};
