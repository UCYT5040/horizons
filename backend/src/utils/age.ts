const AGE_OUT_THRESHOLD = 19;

export function calculateAge(birthday: Date | string): number {
  const b = birthday instanceof Date ? birthday : new Date(birthday);
  const today = new Date();
  let age = today.getFullYear() - b.getFullYear();
  const monthDiff = today.getMonth() - b.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < b.getDate())) {
    age -= 1;
  }
  return age;
}

// Aged-out users keep grandfathered rights (shipping pre-existing projects,
// spending their balance) even though Hack Club eligibility ends at 19.
export function isAgedOut(
  birthday: Date | string | null,
  ageOverride?: boolean | null,
): boolean {
  return !!birthday && !ageOverride && calculateAge(birthday) >= AGE_OUT_THRESHOLD;
}
