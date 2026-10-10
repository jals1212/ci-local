export interface PlanStep {
  kind: 'box' | 'host'
  name: string
  /** Jobs that select the step; empty: always. */
  jobs: string[]
  tags: string[]
  timeout: number | null
  /** Why the step runs another command than its workflow step (`--deviates`). */
  deviates: string | null
  /** KEY=VALUE entries. */
  env: string[]
  /** Variables passed from the host by name. */
  pass: string[]
  /** Box: the shell script. Host: the function and its quoted arguments. */
  command: string
  /** Host steps: the arguments given to the function. */
  args?: string[]
  /** Host steps: the function's source, from `declare -f`. */
  source?: string
}

export interface Plan {
  version: string
  project: string
  workflow: string
  jobs: string[]
  runnerArgs: string[]
  notMirrored: { name: string; reason: string }[]
  steps: PlanStep[]
}

export interface Workflow {
  jobs?: Record<
    string,
    {
      env?: Record<string, unknown>
      strategy?: { matrix?: Record<string, unknown> & { include?: Record<string, unknown>[] } }
      steps?: { name?: string; run?: string; uses?: string; with?: Record<string, unknown> }[]
    }
  >
}

export function loadPlan(options?: { cwd?: string; env?: Record<string, string> }): Promise<Plan>
export function loadWorkflow(options?: { cwd?: string; path?: string; plan?: Plan }): Promise<Workflow>
export function logicalLines(source: string): string[]
export function stepEnv(step: PlanStep): Record<string, string>
export function mirroringProblems(
  plan: Plan,
  workflow: Workflow,
  options?: { substitutions?: [string, string][] }
): string[]
export function publishedPortProblems(plan: Plan): string[]
export function nodeVersionProblems(workflow: Workflow, options?: { cwd?: string }): Promise<string[]>
export function parityProblems(options?: {
  cwd?: string
  substitutions?: [string, string][]
}): Promise<string[]>
