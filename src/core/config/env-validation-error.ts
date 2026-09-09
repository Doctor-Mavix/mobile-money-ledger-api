export interface EnvIssue {
  variable: string;
  message: string;
}

export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    const details = issues.map((issue) => `  - ${issue.variable}: ${issue.message}`).join('\n');
    super(`Invalid environment configuration:\n${details}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}
