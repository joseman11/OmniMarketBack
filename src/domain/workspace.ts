/** Every account owns an isolated workspace; the audit fixtures live in the test administrator's workspace. */
export const TEST_ADMIN_ID = "00000000-0000-4000-8000-000000000001";

export function isTestWorkspace(ownerId: string): boolean {
  return ownerId === TEST_ADMIN_ID;
}
