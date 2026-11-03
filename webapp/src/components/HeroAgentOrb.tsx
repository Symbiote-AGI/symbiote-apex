import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useChatVoiceAudioAnalysis, type MicrophoneAudioAnalysis } from './ChatVoiceControls';
import type { HeroOrbState } from './activity-orb-state';
import HeroOrbAdaptiveController from './hero-orb-adaptive-controller';
import { hslToRgb } from './hero-orb-appearance';
import type { HeroOrbAppearance } from './hero-orb-appearance';
import { createHeroOrbGeometryData, HERO_ORB_PARTICLE_COUNT } from './hero-orb-geometry';

interface HeroAgentOrbProps {
  activity: HeroOrbState;
  appearance: HeroOrbAppearance;
}

const ORB_STATES: HeroOrbState[] = ['idle', 'thinking', 'executing', 'responding'];
const ORB_STATE_LABELS: Record<HeroOrbState, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  executing: 'Executing',
  responding: 'Responding',
};

function weightsForState(state: HeroOrbState): THREE.Vector4 {
  const weights = new THREE.Vector4();
  weights.setComponent(ORB_STATES.indexOf(state), 1);
  return weights;
}

function createParticleGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const data = createHeroOrbGeometryData();
  const idleAttribute = new THREE.BufferAttribute(data.idle, 3);
  geometry.setAttribute('position', idleAttribute);
  geometry.setAttribute('aPosIdle', idleAttribute);
  geometry.setAttribute('aPosThinking', new THREE.BufferAttribute(data.thinking, 3));
  geometry.setAttribute('aPosExecuting', new THREE.BufferAttribute(data.executing, 3));
  geometry.setAttribute('aPosResponding', new THREE.BufferAttribute(data.responding, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(data.seeds, 4));
  geometry.setDrawRange(0, HERO_ORB_PARTICLE_COUNT);
  return geometry;
}

function colorForHue(hue: number): THREE.Vector3 {
  const [red, green, blue] = hslToRgb(hue, 0.82, 0.56);
  return new THREE.Vector3(red, green, blue);
}

function applyOrbAppearance(material: THREE.ShaderMaterial, appearance: HeroOrbAppearance): void {
  material.uniforms.uBrightness.value = appearance.brightness;
  material.uniforms.uCol0.value.copy(colorForHue(appearance.hues.idle));
  material.uniforms.uCol1.value.copy(colorForHue(appearance.hues.thinking));
  material.uniforms.uCol2.value.copy(colorForHue(appearance.hues.executing));
  material.uniforms.uCol3.value.copy(colorForHue(appearance.hues.responding));
}

function createParticleMaterial(pixelRatio: number, appearance: HeroOrbAppearance): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWeights: { value: new THREE.Vector4(1, 0, 0, 0) },
      uAudio: { value: new THREE.Vector4() },
      uPulse: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uBrightness: { value: appearance.brightness },
      uCol0: { value: colorForHue(appearance.hues.idle) },
      uCol1: { value: colorForHue(appearance.hues.thinking) },
      uCol2: { value: colorForHue(appearance.hues.executing) },
      uCol3: { value: colorForHue(appearance.hues.responding) },
    },
    vertexShader: `
      uniform float uTime;
      uniform vec4 uWeights;
      uniform vec4 uAudio;
      uniform float uPulse;
      uniform float uPixelRatio;
      uniform float uBrightness;
      uniform vec3 uCol0, uCol1, uCol2, uCol3;

      attribute vec3 aPosIdle, aPosThinking, aPosExecuting, aPosResponding;
      attribute vec4 aSeed;
      varying vec3 vColor;
      varying float vAlpha;

      mat2 rot2(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}

      void main(){
        float bass = uAudio.x;
        float amp = uAudio.w;
        vec3 pI = aPosIdle * (1.0 + 0.018*sin(uTime*0.8) + bass*0.018);
        vec3 pT = aPosThinking;
        pT.xz = rot2(uTime*0.16) * pT.xz;
        pT.y += sin(uTime*1.1 + aSeed.w*6.28318)*0.022;
        vec3 pE = aPosExecuting;
        float scan = pow(max(0.0, cos(aSeed.x*6.28318 - uTime*2.1)), 24.0);
        pE.xz = rot2(uTime*0.24) * pE.xz;
        pE *= 1.0 + 0.012*sin(uTime*2.0);
        float responseWave = sin(uTime*2.3 - aSeed.z*6.28318);
        vec3 pR = aPosResponding * (1.0 + 0.035*responseWave + amp*0.018);
        vec3 pos = pI*uWeights.x + pT*uWeights.y + pE*uWeights.z + pR*uWeights.w;
        pos *= 1.0 + uPulse*0.025 + amp*0.018;

        vec4 mv = modelViewMatrix * vec4(pos,1.0);
        gl_Position = projectionMatrix * mv;

        vec3 c0 = uCol0 * (0.86 + aSeed.y*0.14);
        vec3 c1 = uCol1 * (0.86 + aSeed.y*0.14);
        vec3 c2 = uCol2 * (0.86 + aSeed.y*0.14);
        vec3 c3 = uCol3 * (0.86 + aSeed.y*0.14);
        vec3 blended = c0*uWeights.x + c1*uWeights.y + c2*uWeights.z + c3*uWeights.w;
        vec3 lit = uBrightness <= 0.5
          ? mix(vec3(1.0), blended, uBrightness * 2.0)
          : mix(blended, vec3(0.0), (uBrightness - 0.5) * 2.0);

        float depth = 1.0 - smoothstep(7.5, 9.2, -mv.z);
        float responseGlow = (0.5 + 0.5*responseWave) * uWeights.w;
        vColor = lit + vec3(scan*uWeights.z*0.42 + responseGlow*0.08 + amp*0.035 + uPulse*0.035)
          * (1.0 - uBrightness * 0.5);
        vAlpha = min(1.0, (0.68 + 0.14*aSeed.y + scan*uWeights.z*0.2 + responseGlow*0.08) * depth);

        float size = 1.9 + aSeed.y*0.75 + scan*uWeights.z*1.15 + responseGlow*0.3;
        size *= 1.0 + amp*0.12 + uPulse*0.12;
        gl_PointSize = size * uPixelRatio * (6.0 / max(0.35, -mv.z));
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;

      void main(){
        vec2 uv = gl_PointCoord - 0.5;
        float distanceFromCenter = length(uv);
        if (distanceFromCenter > 0.5) discard;
        float glow = exp(-distanceFromCenter*distanceFromCenter*12.0);
        float halo = exp(-distanceFromCenter*distanceFromCenter*5.5)*0.4;
        float alpha = (glow + halo) * vAlpha;
        vec3 color = mix(vColor, vColor*1.1+0.05, glow*0.3);
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

function updateAudio(
  delta: number,
  analysis: MicrophoneAudioAnalysis | null,
  smoothedAudio: THREE.Vector4,
  phase: { value: number },
): void {
  if (analysis && analysis.context.state === 'running') {
    analysis.analyser.getByteFrequencyData(analysis.frequencies);
    let bass = 0;
    let mid = 0;
    let high = 0;
    for (let index = 1; index <= 14; index++) bass += analysis.frequencies[index];
    for (let index = 15; index <= 70; index++) mid += analysis.frequencies[index];
    for (let index = 71; index <= 180; index++) high += analysis.frequencies[index];
    bass = Math.min(1.8, (bass / (14 * 255)) * 2);
    mid = Math.min(1.8, (mid / (56 * 255)) * 2.4);
    high = Math.min(1.8, (high / (110 * 255)) * 2.7);
    const overall = bass * 0.4 + mid * 0.45 + high * 0.15;
    const smoothing = 1 - Math.exp(-delta * 18);
    smoothedAudio.x += (bass - smoothedAudio.x) * smoothing;
    smoothedAudio.y += (mid - smoothedAudio.y) * smoothing;
    smoothedAudio.z += (high - smoothedAudio.z) * smoothing;
    smoothedAudio.w += (overall - smoothedAudio.w) * smoothing;
    return;
  }

  phase.value += delta;
  const breath = 0.14 + 0.11 * Math.sin(phase.value * 0.8);
  const pulse = 0.06 + 0.09 * Math.sin(phase.value * 2) * Math.sin(phase.value * 0.6);
  const spark = 0.03 + 0.07 * Math.max(0, Math.sin(phase.value * 4.5));
  const smoothing = 1 - Math.exp(-delta * 2.8);
  smoothedAudio.x += (breath - smoothedAudio.x) * smoothing;
  smoothedAudio.y += (pulse - smoothedAudio.y) * smoothing;
  smoothedAudio.z += (spark - smoothedAudio.z) * smoothing;
  smoothedAudio.w += ((breath * 0.6 + pulse * 0.4) - smoothedAudio.w) * smoothing;
}

export default function HeroAgentOrb({ activity, appearance }: HeroAgentOrbProps) {
  const orbContainerRef = useRef<HTMLDivElement>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const audioAnalysis = useChatVoiceAudioAnalysis();
  const audioAnalysisRef = useRef<MicrophoneAudioAnalysis | null>(audioAnalysis);
  audioAnalysisRef.current = audioAnalysis;
  const currentWeightsRef = useRef(weightsForState(activity));
  const targetWeightsRef = useRef(weightsForState(activity));
  const previousStateRef = useRef(activity);
  const targetStateRef = useRef(activity);
  const transitionElapsedRef = useRef(0);
  const transitionStartWeightRef = useRef(0);
  const transitionCompleteRef = useRef(true);
  const pulseBurstRef = useRef(0);
  const reducedMotionRef = useRef(false);
  const staticRenderRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const material = materialRef.current;
    if (!material) return;
    applyOrbAppearance(material, appearance);
    if (reducedMotionRef.current) staticRenderRef.current?.();
  }, [appearance]);

  useEffect(() => {
    if (previousStateRef.current === activity) return;
    previousStateRef.current = activity;
    targetStateRef.current = activity;
    transitionStartWeightRef.current = currentWeightsRef.current.getComponent(ORB_STATES.indexOf(activity));
    transitionElapsedRef.current = 0;
    transitionCompleteRef.current = false;
    targetWeightsRef.current.copy(weightsForState(activity));
    pulseBurstRef.current = 1;
    if (reducedMotionRef.current) staticRenderRef.current?.();
  }, [activity]);

  useEffect(() => {
    const container = orbContainerRef.current;
    if (!container) return;

    const adaptiveController = new HeroOrbAdaptiveController();
    let basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelRatio = Math.max(1, adaptiveController.getPixelRatio(basePixelRatio));
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
        alpha: true,
      });
    } catch (failure) {
      console.error('[hero-orb] WebGL renderer initialization failed:', failure);
      setUnavailable(true);
      return;
    }

    const bounds = container.getBoundingClientRect();
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, width / height, 0.1, 100);
    camera.position.set(0, 0.1, 6.6);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    let geometry: THREE.BufferGeometry;
    let material: THREE.ShaderMaterial;
    try {
      geometry = createParticleGeometry();
      material = createParticleMaterial(pixelRatio, appearance);
    } catch (failure) {
      console.error('[hero-orb] Particle animation initialization failed:', failure);
      renderer.dispose();
      setUnavailable(true);
      return;
    }

    const points = new THREE.Points(geometry, material);
    materialRef.current = material;
    scene.add(points);
    container.appendChild(renderer.domElement);
    setUnavailable(false);

    const timer = new THREE.Timer();
    timer.reset();
    const smoothedAudio = new THREE.Vector4();
    const phase = { value: 0 };
    let elapsedTime = 0;
    let frameId: number | null = null;
    let contextLost = false;
    let disposed = false;

    const renderStaticFrame = () => {
      if (disposed || contextLost) return;
      currentWeightsRef.current.copy(targetWeightsRef.current);
      transitionElapsedRef.current = 0;
      transitionCompleteRef.current = true;
      material.uniforms.uWeights.value.copy(currentWeightsRef.current);
      material.uniforms.uAudio.value.set(0, 0, 0, 0);
      material.uniforms.uPulse.value = 0;
      material.uniforms.uTime.value = 0;
      renderer.render(scene, camera);
    };
    staticRenderRef.current = renderStaticFrame;

    let renderedWidth = width;
    let renderedHeight = height;
    let renderedPixelRatio = pixelRatio;
    const resizeRenderer = () => {
      const nextBounds = container.getBoundingClientRect();
      if (nextBounds.width <= 0 || nextBounds.height <= 0) return;
      const nextWidth = nextBounds.width;
      const nextHeight = nextBounds.height;
      basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const nextPixelRatio = Math.max(1, adaptiveController.getPixelRatio(basePixelRatio));
      if (nextWidth === renderedWidth && nextHeight === renderedHeight && nextPixelRatio === renderedPixelRatio) return;

      renderedWidth = nextWidth;
      renderedHeight = nextHeight;
      renderedPixelRatio = nextPixelRatio;
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(nextPixelRatio);
      renderer.setSize(nextWidth, nextHeight, false);
      material.uniforms.uPixelRatio.value = nextPixelRatio;
      if (reducedMotionRef.current) renderStaticFrame();
    };

    const animate = (timestamp: number) => {
      frameId = null;
      if (disposed || contextLost || document.hidden || reducedMotionRef.current) return;

      timer.update(timestamp);
      const frameDuration = Math.max(0, timer.getDelta());
      const delta = Math.min(frameDuration, 0.05);
      elapsedTime += delta;
      updateAudio(delta, audioAnalysisRef.current, smoothedAudio, phase);
      material.uniforms.uAudio.value.copy(smoothedAudio);

      if (!transitionCompleteRef.current) transitionElapsedRef.current += frameDuration;
      const transition = 1 - Math.exp(-delta * adaptiveController.getTransitionRate(targetStateRef.current));
      const currentWeights = currentWeightsRef.current;
      const targetWeights = targetWeightsRef.current;
      currentWeights.x += (targetWeights.x - currentWeights.x) * transition;
      currentWeights.y += (targetWeights.y - currentWeights.y) * transition;
      currentWeights.z += (targetWeights.z - currentWeights.z) * transition;
      currentWeights.w += (targetWeights.w - currentWeights.w) * transition;
      const totalWeight = currentWeights.x + currentWeights.y + currentWeights.z + currentWeights.w;
      if (totalWeight > 1e-4) {
        material.uniforms.uWeights.value.set(
          currentWeights.x / totalWeight,
          currentWeights.y / totalWeight,
          currentWeights.z / totalWeight,
          currentWeights.w / totalWeight,
        );
      }

      const targetIndex = ORB_STATES.indexOf(targetStateRef.current);
      const startingDistance = 1 - transitionStartWeightRef.current;
      const remainingDistance = 1 - currentWeights.getComponent(targetIndex);
      const transitionProgress = startingDistance > 0
        ? 1 - remainingDistance / startingDistance
        : 1;
      if (!transitionCompleteRef.current && transitionProgress >= 0.975) {
        if (startingDistance >= 0.05) {
          adaptiveController.recordTransition(targetStateRef.current, transitionElapsedRef.current);
        }
        transitionCompleteRef.current = true;
      }

      pulseBurstRef.current *= Math.exp(-delta * 3.6);
      material.uniforms.uPulse.value = pulseBurstRef.current;
      material.uniforms.uTime.value = elapsedTime;
      points.rotation.y = elapsedTime * 0.1;
      if (adaptiveController.observeFrame(frameDuration * 1000)) {
        const nextPixelRatio = Math.max(1, adaptiveController.getPixelRatio(basePixelRatio));
        renderer.setPixelRatio(nextPixelRatio);
        material.uniforms.uPixelRatio.value = nextPixelRatio;
      }
      renderer.render(scene, camera);
      scheduleFrame();
    };
    const scheduleFrame = () => {
      if (!disposed && !contextLost && !document.hidden && !reducedMotionRef.current && frameId === null) {
        frameId = window.requestAnimationFrame(animate);
      }
    };
    const cancelFrame = () => {
      if (frameId === null) return;
      window.cancelAnimationFrame(frameId);
      frameId = null;
    };

    const resizeObserver = new ResizeObserver(resizeRenderer);
    resizeObserver.observe(container);
    window.addEventListener('resize', resizeRenderer);

    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotionRef.current = motionPreference.matches;
    const onMotionPreferenceChange = (event: MediaQueryListEvent) => {
      reducedMotionRef.current = event.matches;
      if (event.matches) {
        cancelFrame();
        renderStaticFrame();
      } else {
        timer.reset();
        scheduleFrame();
      }
    };
    motionPreference.addEventListener('change', onMotionPreferenceChange);

    const onVisibilityChange = () => {
      if (document.hidden) {
        cancelFrame();
      } else if (!reducedMotionRef.current) {
        timer.reset();
        scheduleFrame();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const onContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      cancelFrame();
      console.error('[hero-orb] WebGL context was lost.');
      setUnavailable(true);
    };
    const onContextRestored = () => {
      contextLost = false;
      setUnavailable(false);
      if (reducedMotionRef.current) renderStaticFrame();
      else scheduleFrame();
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

    if (reducedMotionRef.current) renderStaticFrame();
    else scheduleFrame();

    return () => {
      disposed = true;
      cancelFrame();
      staticRenderRef.current = null;
      resizeObserver.disconnect();
      window.removeEventListener('resize', resizeRenderer);
      motionPreference.removeEventListener('change', onMotionPreferenceChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      timer.dispose();
      scene.remove(points);
      geometry.dispose();
      material.dispose();
      if (materialRef.current === material) materialRef.current = null;
      renderer.dispose();
      if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div
      ref={orbContainerRef}
      className={`hero-agent-orb${unavailable ? ' hero-agent-orb--fallback' : ''}`}
      role="img"
      aria-label={`Main agent: ${ORB_STATE_LABELS[activity]}${unavailable ? '. Orb animation unavailable' : ''}`}
    />
  );
}
