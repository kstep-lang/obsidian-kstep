export interface KStepSettings {
  /**
   * Path to the kstep-cli binary. Two common values:
   *   - "kstep-cli"  — Gradle `installDist` build (development, verified name).
   *   - "kstep"      — a future package-manager install (Homebrew tap etc.).
   * Absolute paths are also accepted, e.g.
   * "/home/irakli/IdeaProjects/kSTEP/kstep-cli/build/install/kstep-cli/bin/kstep-cli".
   */
  cliPath: string;
}

export const DEFAULT_SETTINGS: KStepSettings = {
  cliPath: "kstep-cli",
};
