import type { InjectionToken } from 'tsyringe';

import type { StatementService } from './statement.service';

export const STATEMENT_SERVICE = Symbol('StatementService') as InjectionToken<StatementService>;
