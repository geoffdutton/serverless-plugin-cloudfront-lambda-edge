# Example: Existing CF Distribution

## Deploying

An example deployment command would be:
```
AWS_PROFILE=<specific prof if necessary> sls deploy --stage dev --distribution-id <CF distro ID>
```

## Removing
Since Lambda@Edge are replicated functions associated with a CloudFront distribution, you need to remove that association first: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-edge-delete-replicas.html

Wait for the CloudFront distribution to finish deploying after making the edits, and then you can run:

```
AWS_PROFILE=<specific prof if necessary> sls remove --stage dev --distribution-id <CF distro ID>
```
