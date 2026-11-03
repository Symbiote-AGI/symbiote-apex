export const HERO_ORB_PARTICLE_COUNT = 1_000;

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const ORB_RADIUS = 1.42;

export interface HeroOrbGeometryData {
  idle: Float32Array;
  thinking: Float32Array;
  executing: Float32Array;
  responding: Float32Array;
  seeds: Float32Array;
}

export function createHeroOrbGeometryData(): HeroOrbGeometryData {
  const idle = new Float32Array(HERO_ORB_PARTICLE_COUNT * 3);
  const thinking = new Float32Array(HERO_ORB_PARTICLE_COUNT * 3);
  const executing = new Float32Array(HERO_ORB_PARTICLE_COUNT * 3);
  const responding = new Float32Array(HERO_ORB_PARTICLE_COUNT * 3);
  const seeds = new Float32Array(HERO_ORB_PARTICLE_COUNT * 4);
  const trackCount = Math.ceil(HERO_ORB_PARTICLE_COUNT / 4);
  const orbitCount = Math.ceil(HERO_ORB_PARTICLE_COUNT / 3);

  for (let index = 0; index < HERO_ORB_PARTICLE_COUNT; index++) {
    const position = index * 3;
    const seed = index * 4;
    const sphereY = 1 - 2 * ((index + 0.5) / HERO_ORB_PARTICLE_COUNT);
    const sphereRadius = Math.sqrt(1 - sphereY * sphereY);
    const sphereAngle = GOLDEN_ANGLE * index;
    const track = index % 4;
    const trackProgress = (Math.floor(index / 4) + 0.5) / trackCount;
    const orbit = index % 3;
    const orbitProgress = (Math.floor(index / 3) + 0.5) / orbitCount;
    const orbitAngle = orbitProgress * TAU;
    const layer = index % 4;
    const layerPoint = Math.floor(index / 4);
    const layerProgress = (layerPoint + 0.5) / trackCount;
    const layerY = 1 - 2 * layerProgress;
    const layerRadius = Math.sqrt(1 - layerY * layerY);
    const layerAngle = GOLDEN_ANGLE * layerPoint;
    const responseRadius = 0.82 + layer * 0.2;

    idle[position] = ORB_RADIUS * sphereRadius * Math.cos(sphereAngle);
    idle[position + 1] = ORB_RADIUS * sphereY;
    idle[position + 2] = ORB_RADIUS * sphereRadius * Math.sin(sphereAngle);

    const helixY = (trackProgress - 0.5) * 2;
    const helixRadius = Math.sqrt(1 - helixY * helixY) * ORB_RADIUS;
    const helixAngle = trackProgress * TAU * 3.5 + track * TAU / 4;
    thinking[position] = helixRadius * Math.cos(helixAngle);
    thinking[position + 1] = helixY * ORB_RADIUS * 0.93;
    thinking[position + 2] = helixRadius * Math.sin(helixAngle);

    if (orbit === 0) {
      executing[position] = ORB_RADIUS * Math.cos(orbitAngle);
      executing[position + 1] = ORB_RADIUS * Math.sin(orbitAngle);
    } else if (orbit === 1) {
      executing[position + 1] = ORB_RADIUS * Math.cos(orbitAngle);
      executing[position + 2] = ORB_RADIUS * Math.sin(orbitAngle);
    } else {
      executing[position] = ORB_RADIUS * Math.cos(orbitAngle);
      executing[position + 2] = ORB_RADIUS * Math.sin(orbitAngle);
    }

    responding[position] = responseRadius * layerRadius * Math.cos(layerAngle);
    responding[position + 1] = responseRadius * layerY;
    responding[position + 2] = responseRadius * layerRadius * Math.sin(layerAngle);

    seeds[seed] = orbitProgress;
    seeds[seed + 1] = sphereY * 0.5 + 0.5;
    seeds[seed + 2] = layer / 4;
    seeds[seed + 3] = index / HERO_ORB_PARTICLE_COUNT;
  }

  return { idle, thinking, executing, responding, seeds };
}
