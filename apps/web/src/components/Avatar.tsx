import { hueOf, initialsOf } from '@couples/space-core';

/** A round avatar with initials; the colour is derived from the name so it is stable and needs no uploaded image. */
export function Avatar({ name, size = 56 }: { name: string; size?: number }) {
  const hue = hueOf(name);
  return (
    <span className="grid shrink-0 place-items-center rounded-full font-semibold text-white shadow-soft" aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(135deg, hsl(${hue} 75% 58%), hsl(${(hue + 50) % 360} 70% 50%))` }}>{initialsOf(name)}</span>
  );
}
