/** Mechanical failures take precedence over environmental blockers. Manual pending work is reported separately. */
export function classifyResults(results) {
  const counts = { passed: 0, failed: 0, 'environment-blocked': 0, pending: 0 };
  for (const result of results) {
    if (!Object.hasOwn(counts, result.status)) throw new Error(`Unknown mechanical status: ${result.status}`);
    counts[result.status]++;
  }
  return { counts, exitCode: counts.failed ? 1 : counts['environment-blocked'] ? 2 : 0 };
}
export function isEnvironmentBlocked(error) {
  return error?.syscall === 'listen' && ['EPERM', 'EACCES', 'EADDRNOTAVAIL'].includes(error?.code);
}
