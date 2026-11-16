export type ButtonProps = { label: string; onClick?: () => void };

/** Shared primary button used across features. */
export function Button({ label, onClick }: ButtonProps) {
  return <button type="button" onClick={onClick}>{label}</button>;
}
