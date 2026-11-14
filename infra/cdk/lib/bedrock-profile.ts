import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface BedrockProfileProps {
  /** Resource name, e.g. `{project}-bedrock-{env}` (max 64 chars). */
  profileName: string;
  /** System-defined profile to copy, e.g. `eu.amazon.nova-lite-v1:0` or `global.amazon.nova-2-lite-v1:0`. */
  systemProfileId: string;
  /**
   * Tags for the profile. Defaults to the stack's tags; pass them explicitly when the stack is
   * tagged via `Tags.of(...)` (an Aspect), which only resolves at synth, after construction.
   */
  tags?: Record<string, string>;
}

/**
 * Application inference profile (one per model). Invoking Bedrock through its ARN makes token
 * spend show up in Cost Explorer split by the stack's cost-allocation tags (project, environment);
 * invoking a plain model ID cannot be tagged, so Bedrock appears as one untagged cost.
 * Not retroactive: only usage after deployment is attributed.
 *
 * Created through the Bedrock API (custom resource) instead of
 * `AWS::Bedrock::ApplicationInferenceProfile`: that CloudFormation type does not exist in
 * eu-south-2 ("Unrecognized resource types"), while the Bedrock API itself does.
 */
export class BedrockProfile extends Construct {
  /** Pass this ARN as `modelId` when invoking the model. */
  readonly arn: string;
  private readonly invokeResources: string[];

  constructor(scope: Construct, id: string, props: BedrockProfileProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const { region, account } = stack;

    const systemProfileArn = `arn:aws:bedrock:${region}:${account}:inference-profile/${props.systemProfileId}`;
    const foundationModelId = props.systemProfileId.replace(/^(eu|us|apac|global)\./, '');
    const foundationModelArn = `arn:aws:bedrock:*::foundation-model/${foundationModelId}`;
    const appProfilesArn = `arn:aws:bedrock:${region}:${account}:application-inference-profile/*`;

    // Stack-level tags are not propagated to custom-resource-created resources, so the
    // cost-allocation tags (project, environment, ...) are passed explicitly on create.
    const tags = Object.entries(props.tags ?? stack.tags.tagValues()).map(([key, value]) => ({
      key,
      value,
    }));
    const profileId = new cr.PhysicalResourceIdReference();

    const profile = new cr.AwsCustomResource(this, 'Profile', {
      onCreate: {
        service: 'Bedrock',
        action: 'CreateInferenceProfile',
        parameters: {
          inferenceProfileName: props.profileName,
          description: 'Cost attribution profile',
          modelSource: { copyFrom: systemProfileArn },
          tags,
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('inferenceProfileArn'),
      },
      // Profiles are immutable; an update (e.g. a changed tag) only re-reads the existing one.
      // Without onUpdate, CDK would re-run onCreate and fail on the duplicate name.
      onUpdate: {
        service: 'Bedrock',
        action: 'GetInferenceProfile',
        parameters: { inferenceProfileIdentifier: profileId },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('inferenceProfileArn'),
      },
      onDelete: {
        service: 'Bedrock',
        action: 'DeleteInferenceProfile',
        parameters: { inferenceProfileIdentifier: profileId },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock:CreateInferenceProfile',
            'bedrock:GetInferenceProfile',
            'bedrock:DeleteInferenceProfile',
            'bedrock:TagResource',
          ],
          resources: [appProfilesArn, systemProfileArn, foundationModelArn],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    this.arn = profile.getResponseField('inferenceProfileArn');
    // Invoking through an application profile requires access to the profile itself, the
    // system profile it copies and the underlying foundation model in the routed regions.
    this.invokeResources = [this.arn, systemProfileArn, foundationModelArn];
  }

  grantInvoke(grantee: iam.IGrantable): void {
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['bedrock:InvokeModel'],
      resourceArns: this.invokeResources,
    });
  }
}
