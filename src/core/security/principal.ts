/**
 * The authenticated caller, as the rest of the application sees it. Declared in the core so
 * that shared code can read an identity without importing the auth module: the core owns the
 * shape, the auth module owns how it is proven.
 */
export interface Principal {
  id: string;
  actorType: string;
  roles: readonly string[];
  permissions: readonly string[];
  sessionId: string;
}
