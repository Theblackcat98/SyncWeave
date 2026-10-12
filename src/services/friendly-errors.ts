/**
 * Map low-level errno / network errors to actionable user-facing messages.
 * Raw "ENOSPC" or "ECONNREFUSED" tells the user nothing; these tell them
 * what to do next.
 */
export function friendlyErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: string })?.code

  // Disk / filesystem.
  if (code === "ENOSPC" || message.includes("ENOSPC")) {
    return "Disk is full on the receiver — free space and retry"
  }
  if (code === "EACCES" || code === "EPERM" || message.includes("EACCES") || message.includes("EPERM")) {
    return `Permission denied: ${message} — check directory permissions`
  }
  if (code === "ENOENT" || message.includes("ENOENT")) {
    return `File or directory not found: ${message}`
  }
  if (code === "EEXIST" || message.includes("EEXIST")) {
    return `Destination already exists and could not be renamed: ${message}`
  }
  // Network.
  if (code === "ECONNREFUSED" || message.includes("ECONNREFUSED")) {
    return "Connection refused — is the other instance running on that port?"
  }
  if (code === "ETIMEDOUT" || message.includes("ETIMEDOUT")) {
    return "Connection timed out — check the network and firewall"
  }
  if (code === "EHOSTUNREACH" || message.includes("EHOSTUNREACH")) {
    return "Host unreachable — check the IP address and network"
  }
  if (code === "ENETUNREACH" || message.includes("ENETUNREACH")) {
    return "Network unreachable — are both machines on the same LAN?"
  }
  // Protocol-level (already friendly, pass through).
  return message
}
