export type ProxyType='bill'|'appointment'|'task';
export type ActionStatus='proposed'|'awaiting_approval'|'approved'|'executing'|'completed'|'failed'|'rejected';
export interface ProposedAction{id:string;proxy:ProxyType;action:string;description:string;riskLevel:0|1|2|3|4;requiresApproval:boolean;status:ActionStatus;payload:Record<string,unknown>;createdAt:string;}
export interface Bill {
  id: string;
  merchant: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  accountLastFour: string | null;
  source: 'MANUAL' | 'FORWARDED_EMAIL';
  status: 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED';
  approvalRequired: boolean;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  decidedAt: string | null;
}
