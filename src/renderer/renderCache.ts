import type { SceneObject } from "./mesh";

interface LightInput {
    position: [number, number, number];
    intensity: number;
}

/**
 * Build a lightweight string signature of the inputs that affect shadow
 * visibility. When this signature matches the previous frame's signature,
 * the expensive shadow computation can be skipped entirely.
 *
 * The cost of building this key is O(lights + objects) which is negligible
 * compared to the O(lights * triangles * 8) shadow computation.
 */
export function buildShadowCacheKey(
    objects: SceneObject[],
    lights: LightInput[],
    quality: number,
    smoothShadows: boolean
): string {
    let key = `${quality.toFixed(3)}|${smoothShadows ? 1 : 0}|${lights.length}`;
    for (let i = 0; i < lights.length; i++) {
        const l = lights[i];
        key += `|L${l.position[0].toFixed(3)},${l.position[1].toFixed(3)},${l.position[2].toFixed(3)},${l.intensity.toFixed(3)}`;
    }
    for (let i = 0; i < objects.length; i++) {
        const obj = objects[i];
        const t = obj.transform;
        key += `|O${obj.mesh.vertices.length},${obj.mesh.triangles.length}`;
        key += `;${t.position[0].toFixed(3)},${t.position[1].toFixed(3)},${t.position[2].toFixed(3)}`;
        key += `;${t.rotation[0].toFixed(3)},${t.rotation[1].toFixed(3)},${t.rotation[2].toFixed(3)}`;
        key += `;${t.scale[0].toFixed(3)}`;
    }
    return key;
}

/**
 * Build a signature of all inputs that affect the WebGL vertex data
 * (positions, normals, colors, UVs, shadow masks, etc.). When this
 * matches, we can skip vertex rebuilding and buffer uploads entirely.
 */
export function buildVertexCacheKey(
    objects: SceneObject[],
    lights: LightInput[],
    shadowQuality: number,
    smoothShading: boolean,
    smoothingAngleThreshold: number
): string {
    let key = `${shadowQuality.toFixed(3)}|${smoothShading ? 1 : 0}|${smoothingAngleThreshold.toFixed(1)}|${lights.length}`;
    for (let i = 0; i < lights.length; i++) {
        const l = lights[i];
        key += `|L${l.position[0].toFixed(3)},${l.position[1].toFixed(3)},${l.position[2].toFixed(3)},${l.intensity.toFixed(3)}`;
    }
    for (let i = 0; i < objects.length; i++) {
        const obj = objects[i];
        const t = obj.transform;
        const m = obj.mesh;
        key += `|O${m.vertices.length},${m.triangles.length},${m.color},${m.textureData ? 1 : 0},${m.bumpMapData ? 1 : 0}`;
        key += `;${t.position[0].toFixed(3)},${t.position[1].toFixed(3)},${t.position[2].toFixed(3)}`;
        key += `;${t.rotation[0].toFixed(3)},${t.rotation[1].toFixed(3)},${t.rotation[2].toFixed(3)}`;
        key += `;${t.scale[0].toFixed(3)}`;
    }
    return key;
}

/**
 * Build a signature for the per-object normal/vertex transform cache used
 * by the software renderer. When this matches, we can skip transforming
 * vertices and recomputing smoothed normals.
 */
export function buildObjectCacheKey(
    mesh: SceneObject["mesh"],
    transform: SceneObject["transform"],
    angleThreshold: number
): string {
    const t = transform;
    return `${mesh.vertices.length},${mesh.triangles.length}|${t.position[0].toFixed(3)},${t.position[1].toFixed(3)},${t.position[2].toFixed(3)}|${t.rotation[0].toFixed(3)},${t.rotation[1].toFixed(3)},${t.rotation[2].toFixed(3)}|${t.scale[0].toFixed(3)}|${angleThreshold.toFixed(1)}`;
}
