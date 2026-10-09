export type ComplianceState = 'noncompliant' | 'compliant' | 'unknown';
export type Device = { id: string; hostname: string; os: string; compliance: ComplianceState; encrypted: boolean; escrowed: boolean; lastSeen: string };
export type Incident = { id: string; title: string; description: string; severity: 'high'|'medium'|'low'; status: 'open'|'investigating'|'resolved'; createdAt: string; affectedDevices: number; tags: string[] };
export type Evidence = { taskId: string; status: 'not-started'|'in-progress'|'verified'; prUrl?: string; testCommand?: string; testResult?: string; reviewedBy?: string };
