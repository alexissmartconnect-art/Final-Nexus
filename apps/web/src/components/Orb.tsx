import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export type OrbState =
  | 'idle' | 'listening' | 'thinking' | 'searching' | 'generating'
  | 'debating' | 'executing' | 'success' | 'error';

const STATE_COLOR: Record<OrbState, [number, number]> = {
  idle:       [0.27, 0.90],   // cyan
  listening:  [0.30, 0.99],
  thinking:   [0.55, 0.42],   // violet
  searching:  [0.46, 0.75],
  generating: [0.62, 0.86],
  debating:   [0.72, 0.30],
  executing:  [1.00, 0.79],   // gold
  success:    [0.25, 0.88],   // green-cyan
  error:      [1.00, 0.36],
};

const STATE_SPEED: Record<OrbState, number> = {
  idle: 0.35, listening: 0.6, thinking: 1.05, searching: 1.3,
  generating: 1.5, debating: 1.15, executing: 1.75, success: 0.8, error: 2.1,
};

interface OrbProps {
  state?: OrbState;
  size?: number;
  /** Disable WebGL and render the static CSS fallback. */
  lite?: boolean;
}

const VERT = /* glsl */`
  uniform float uTime;
  uniform float uAmp;
  varying vec3 vNormal;
  varying vec3 vPos;

  // classic 3d simplex-ish noise (cheap, deterministic)
  float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123); }
  float noise(vec3 p){
    vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(mix(hash(i), hash(i+vec3(1,0,0)), f.x),
                   mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x),
                   mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z);
  }

  void main(){
    vNormal = normalize(normalMatrix * normal);
    float n = noise(position * 1.6 + vec3(uTime * 0.35));
    float n2 = noise(position * 3.4 - vec3(uTime * 0.22));
    vec3 displaced = position + normal * (n * 0.20 + n2 * 0.09) * uAmp;
    vPos = displaced;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

const FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uPower;
  varying vec3 vNormal;
  varying vec3 vPos;

  void main(){
    vec3 viewDir = normalize(cameraPosition - vPos);
    float fres = pow(1.0 - max(dot(vNormal, viewDir), 0.0), 2.2);
    float bands = 0.5 + 0.5 * sin(vPos.y * 22.0 + uTime * 1.6);
    vec3 col = mix(uColorA, uColorB, fres) + uColorB * bands * 0.16;
    float alpha = clamp(fres * uPower + 0.10, 0.0, 1.0);
    gl_FragColor = vec4(col, alpha);
  }
`;

/**
 * Holographic orb. Real WebGL (three.js), no video, no image asset.
 * Falls back to a pure-CSS pulse when WebGL is unavailable or `lite` is set.
 */
export function Orb({ state = 'idle', size = 260, lite = false }: OrbProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<OrbState>(state);
  const [webglOk, setWebglOk] = useWebglOk(!lite);
  stateRef.current = state;

  useEffect(() => {
    if (lite || !webglOk || !mountRef.current) return;
    const mount = mountRef.current;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 4.2);

    const geo = new THREE.IcosahedronGeometry(1.28, 24);
    const uniforms = {
      uTime: { value: 0 },
      uAmp: { value: 1 },
      uPower: { value: 1.1 },
      uColorA: { value: new THREE.Color(0.05, 0.32, 0.55) },
      uColorB: { value: new THREE.Color(0.27, 0.9, 1.0) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
    });
    const orb = new THREE.Mesh(geo, mat);
    scene.add(orb);

    const wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.55, 1)),
      new THREE.LineBasicMaterial({ color: 0x46e6ff, transparent: true, opacity: 0.16 }),
    );
    scene.add(wire);

    const pGeo = new THREE.BufferGeometry();
    const count = 420;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 1.9 + Math.random() * 0.75;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(p) * Math.cos(t);
      pos[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
      pos[i * 3 + 2] = r * Math.cos(p);
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const points = new THREE.Points(pGeo, new THREE.PointsMaterial({
      color: 0x8b6bff, size: 0.022, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    scene.add(points);

    const clock = new THREE.Clock();
    let raf = 0;
    const target = new THREE.Color();

    const tick = (): void => {
      const dt = clock.getDelta();
      const s = stateRef.current;
      const [h, l] = STATE_COLOR[s]!;
      target.setHSL(h, 0.92, l);
      uniforms.uColorB.value.lerp(target, Math.min(1, dt * 3));
      uniforms.uTime.value += dt * STATE_SPEED[s]!;
      uniforms.uAmp.value += ((s === 'idle' ? 0.55 : 1.15) - uniforms.uAmp.value) * Math.min(1, dt * 2);
      if (!reduced) {
        orb.rotation.y += dt * 0.22;
        orb.rotation.x = Math.sin(uniforms.uTime.value * 0.2) * 0.12;
        wire.rotation.y -= dt * 0.08;
        points.rotation.y += dt * 0.04;
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    const onResize = (): void => renderer.setSize(size, size, false);
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      geo.dispose(); mat.dispose(); wire.geometry.dispose();
      (wire.material as THREE.Material).dispose(); pGeo.dispose();
      (points.material as THREE.Material).dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [lite, webglOk, size]);

  if (lite || !webglOk) {
    return (
      <div className={`orb-lite orb-lite--${state}`} style={{ width: size, height: size }} role="img" aria-label={`NEXUS orb: ${state}`} />
    );
  }
  return <div ref={mountRef} style={{ width: size, height: size }} role="img" aria-label={`NEXUS orb: ${state}`} />;
}

function useWebglOk(enabled: boolean): [boolean, (v: boolean) => void] {
  const ref = useRef(enabled ? detectWebgl() : false);
  return [ref.current, (v: boolean) => { ref.current = v; }];
}

function detectWebgl(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
