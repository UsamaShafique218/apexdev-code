import { isDangerousCommand } from '../tools/shell';
import type { Tool } from '../tools/types';

export type PermissionMode = 'ask' | 'autoEdit' | 'fullAuto';
export type PermissionDecision = 'once' | 'always' | 'deny';

export interface PermissionRequest {
  tool: Tool;
  input: any;
  summary: string;
  /** Dangerous requests can't be covered by "always allow". */
  dangerous: boolean;
}

/** Decides which tool calls need the user's approval. "Always allow" lasts for the current chat. */
export class PermissionPolicy {
  private readonly alwaysAllowed = new Set<string>();

  constructor(private readonly getMode: () => PermissionMode) {}

  check(tool: Tool, input: any): { needsApproval: boolean; dangerous: boolean } {
    const dangerous = tool.name === 'run_command' && isDangerousCommand(String(input?.command ?? ''));
    if (dangerous) return { needsApproval: true, dangerous };
    if (tool.kind === 'read') return { needsApproval: false, dangerous };
    const mode = this.getMode();
    if (mode === 'fullAuto') return { needsApproval: false, dangerous };
    if (mode === 'autoEdit' && tool.kind === 'edit') return { needsApproval: false, dangerous };
    return { needsApproval: !this.alwaysAllowed.has(tool.name), dangerous };
  }

  remember(request: PermissionRequest, decision: PermissionDecision): void {
    if (decision === 'always' && !request.dangerous) this.alwaysAllowed.add(request.tool.name);
  }

  reset(): void {
    this.alwaysAllowed.clear();
  }
}
