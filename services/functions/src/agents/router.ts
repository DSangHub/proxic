import type {ProxyType} from '@proxic/types';
export function route(message:string):ProxyType {const m=message.toLowerCase(); if(/bill|invoice|electric|utility|pay/.test(m)) return 'bill'; if(/doctor|dentist|appointment|schedule|calendar/.test(m)) return 'appointment'; return 'task';}
