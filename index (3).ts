export type ProxyType='bill'|'appointment'|'task';
export type ActionStatus='proposed'|'awaiting_approval'|'approved'|'executing'|'completed'|'failed'|'rejected';
export interface ProposedAction{id:string;proxy:ProxyType;action:string;description:string;riskLevel:0|1|2|3|4;requiresApproval:boolean;status:ActionStatus;payload:Record<string,unknown>;createdAt:string;}
