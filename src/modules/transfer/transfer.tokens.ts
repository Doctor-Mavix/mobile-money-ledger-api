import type { InjectionToken } from 'tsyringe';

import type { TransferService } from './transfer.service';

export const TRANSFER_SERVICE = Symbol('TransferService') as InjectionToken<TransferService>;
