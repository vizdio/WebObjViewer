import {
    createLightMarkerMesh,
    createTransform,
    type Mesh,
    type SceneObject,
} from "./mesh";
import type { Vec3 } from "./math";

export const DEFAULT_TARGET_FPS = 30;
export const DEFAULT_BACKGROUND = "#000000";
export const DEFAULT_CAMERA_POSITION: Vec3 = [0, 0.25, 7];
export const DEFAULT_CAMERA_TARGET: Vec3 = [0, 0, 0];
export const DEFAULT_CAMERA_UP: Vec3 = [0, 1, 0];
export const DEFAULT_LIGHT_POSITION: Vec3 = [0, 0.25, 6.5];
export const DEFAULT_FIELD_OF_VIEW = Math.PI / 3;

export class SceneController {
    objects: SceneObject[];

    private lightMarkerVisible = true;

    constructor(primaryMesh: Mesh) {
        this.objects = [
            {
                mesh: primaryMesh,
                transform: createTransform(
                    [0, 0, 0],
                    [0.15, 0.35, 0],
                    [0.92, 0.92, 0.92]
                ),
            },
            {
                mesh: createLightMarkerMesh(),
                transform: createTransform(
                    [0, 0.25, 6.5],
                    [0, 0, 0],
                    [0.24, 0.24, 0.24]
                ),
            },
        ];
    }

    update(deltaSeconds: number): void {
        void deltaSeconds;
    }

    setPrimaryTransform(position: Vec3, rotation: Vec3, scale: number): void {
        const primaryObject = this.objects[0];
        if (primaryObject === undefined) {
            return;
        }

        primaryObject.transform.position[0] = position[0];
        primaryObject.transform.position[1] = position[1];
        primaryObject.transform.position[2] = position[2];

        primaryObject.transform.rotation[0] = rotation[0];
        primaryObject.transform.rotation[1] = rotation[1];
        primaryObject.transform.rotation[2] = rotation[2];

        primaryObject.transform.scale[0] = scale;
        primaryObject.transform.scale[1] = scale;
        primaryObject.transform.scale[2] = scale;
    }

    setLightMarkerPosition(position: Vec3): void {
        const marker = this.objects[1];
        if (marker === undefined) {
            return;
        }

        marker.transform.position[0] = position[0];
        marker.transform.position[1] = position[1];
        marker.transform.position[2] = position[2];
    }

    setPrimaryColor(color: string): void {
        const primaryObject = this.objects[0];
        if (primaryObject === undefined) {
            return;
        }

        primaryObject.mesh.color = color;
    }

    setPrimaryMesh(mesh: Mesh): void {
        const primaryObject = this.objects[0];
        if (primaryObject === undefined) {
            return;
        }

        primaryObject.mesh = mesh;
    }

    setLightMarkerColor(color: string): void {
        const marker = this.objects[1];
        if (marker === undefined) {
            return;
        }

        marker.mesh.color = color;
    }

    setLightMarkerVisible(visible: boolean): void {
        this.lightMarkerVisible = visible;
    }

    getRenderableObjects(): SceneObject[] {
        return this.lightMarkerVisible
            ? this.objects
            : this.objects.slice(0, 1);
    }
}
