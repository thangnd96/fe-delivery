export function canAccess(roles: string[], required: string): boolean {
  return roles.includes(required);
}
