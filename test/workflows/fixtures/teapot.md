```javascript
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

// Setup Scene
const scene = new THREE.Scene();

/**
 * Procedural Tianqing (Celestial Blue) Ru-kiln Teapot
 * Ru-kiln is known for its elegant, simple shapes and the "sky after rain" glaze color.
 */

// Helper: Procedural Vertex Coloring for "Glaze" effect
function applyGlazeColors(geometry, baseColor, variationColor) {
  const position = geometry.attributes.position;
  const count = position.count;
  const colors = new Float32Array(count * 3);
  const colorA = new THREE.Color(baseColor);
  const colorB = new THREE.Color(variationColor);

  for (let i = 0; i < count; i++) {
    const y = position.getY(i);
    // Create a subtle gradient based on height and a bit of pseudo-randomness
    const noise = Math.sin(y * 10.0 + position.getX(i) * 5.0) * 0.05;
    const t = THREE.MathUtils.clamp((y + 0.5) / 1.5 + noise, 0, 1);

    const mixedColor = new THREE.Color().copy(colorA).lerp(colorB, t);
    colors[i * 3] = mixedColor.r;
    colors[i * 3 + 1] = mixedColor.g;
    colors[i * 3 + 2] = mixedColor.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

// Colors for "Tianqing" (天青色) - A subtle, grayish sky blue
const TIANQING_BASE = 0x94b4b8;
const TIANQING_LIGHT = 0xadc7c7;

// Material: Smooth, satin-like finish typical of Ru-kiln glaze
const teapotMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.25,
  metalness: 0.05,
  side: THREE.DoubleSide,
});

// 1. Teapot Body - Lathe Geometry for a classic ceramic shape
const bodyPoints = [];
for (let i = 0; i <= 10; i++) {
  const t = i / 10;
  // Defining a "pear" or "apple" profile
  const x = Math.sin(t * Math.PI) * 0.8 + 0.1 * Math.pow(t, 2);
  const y = (t - 0.5) * 1.2;
  bodyPoints.push(new THREE.Vector2(x, y));
}
const bodyGeom = new THREE.LatheGeometry(bodyPoints, 32);
applyGlazeColors(bodyGeom, TIANQING_BASE, TIANQING_LIGHT);
const body = new THREE.Mesh(bodyGeom, teapotMaterial);
scene.add(body);

// 2. Teapot Lid
const lidPoints = [];
lidPoints.push(new THREE.Vector2(0, 0.05));
lidPoints.push(new THREE.Vector2(0.4, 0.05));
lidPoints.push(new THREE.Vector2(0.42, 0.0));
lidPoints.push(new THREE.Vector2(0, -0.05));
const lidGeom = new THREE.LatheGeometry(lidPoints, 32);
lidGeom.translate(0, 0.65, 0);

// Lid Knob (The "pearl")
const knobGeom = new THREE.SphereGeometry(0.08, 16, 16);
knobGeom.translate(0, 0.75, 0);

applyGlazeColors(lidGeom, TIANQING_BASE, TIANQING_LIGHT);
applyGlazeColors(knobGeom, TIANQING_BASE, TIANQING_LIGHT);

const lid = new THREE.Mesh(lidGeom, teapotMaterial);
const knob = new THREE.Mesh(knobGeom, teapotMaterial);
scene.add(lid);
scene.add(knob);

// 3. Spout - Curved Tube
const spoutCurve = new THREE.QuadraticBezierCurve3(
  new THREE.Vector3(0.6, 0.1, 0),
  new THREE.Vector3(1.1, 0.1, 0),
  new THREE.Vector3(1.3, 0.7, 0)
);
const spoutGeom = new THREE.TubeGeometry(spoutCurve, 20, 0.12, 12, false);
// Taper the spout manually
const spoutPos = spoutGeom.attributes.position;
for (let i = 0; i < spoutPos.count; i++) {
  const z = spoutPos.getZ(i); // In TubeGeometry, the path runs along X/Y usually, but we check indices
  // TubeGeometry vertices are organized in rings
}
applyGlazeColors(spoutGeom, TIANQING_BASE, TIANQING_LIGHT);
const spout = new THREE.Mesh(spoutGeom, teapotMaterial);
scene.add(spout);

// 4. Handle - Curved Tube
const handleCurve = new THREE.CubicBezierCurve3(
  new THREE.Vector3(-0.6, 0.4, 0),
  new THREE.Vector3(-1.2, 0.8, 0),
  new THREE.Vector3(-1.2, -0.4, 0),
  new THREE.Vector3(-0.5, -0.3, 0)
);
const handleGeom = new THREE.TubeGeometry(handleCurve, 20, 0.08, 12, false);
applyGlazeColors(handleGeom, TIANQING_BASE, TIANQING_LIGHT);
const handle = new THREE.Mesh(handleGeom, teapotMaterial);
scene.add(handle);

// Lighting (Required for MeshStandardMaterial to look good in GLB viewers)
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);
const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
directionalLight.position.set(5, 10, 7.5);
scene.add(directionalLight);

// Final Export
const exporter = new GLTFExporter();
exporter.parse(
  scene,
  (result) => {
    if (result instanceof ArrayBuffer) {
      EXPORT_GLB(result);
    } else {
      // If for some reason it's a JSON object (though binary: true is set)
      EXPORT_GLB(result);
    }
  },
  (err) => {
    EXPORT_ERROR(err);
  },
  { binary: true }
);
```
