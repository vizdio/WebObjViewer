import { composeTransformMat4, transformPoint } from './math'
import type { Vec3 } from './math'
import type { SceneObject } from './mesh'

interface PointLightInput {
  position: Vec3
  intensity: number
}

interface TriangleSample {
  objectIndex: number
  triangleIndex: number
  vertices: [Vec3, Vec3, Vec3]
  centroid: Vec3
}

export interface ObjectShadowVisibility {
  flat: number[][]
  perVertex: [number[], number[], number[]][]
}

const TAU = Math.PI * 2
const MAX_POINT_LIGHTS = 4

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function wrap(value: number, modulus: number): number {
  const remainder = value % modulus
  return remainder < 0 ? remainder + modulus : remainder
}

function directionToUv(direction: Vec3, thetaBins: number, phiBins: number): [number, number] {
  const length = Math.hypot(direction[0], direction[1], direction[2])
  if (length <= 0.000001) {
    return [0, 0]
  }

  const theta = Math.atan2(direction[2], direction[0])
  const normalizedY = clamp(direction[1] / length, -1, 1)
  const phi = Math.acos(normalizedY)
  const thetaPos = ((theta + Math.PI) / TAU) * thetaBins
  const phiPos = (phi / Math.PI) * (phiBins - 1)

  return [thetaPos, phiPos]
}

function buildTriangleSamples(objects: SceneObject[]): TriangleSample[] {
  const samples: TriangleSample[] = []

  objects.forEach((object, objectIndex) => {
    if (object.mesh.emissive) {
      return
    }

    const modelMatrix = composeTransformMat4(
      object.transform.position,
      object.transform.rotation,
      object.transform.scale,
    )
    const transformedVertices = object.mesh.vertices.map((vertex) => transformPoint(modelMatrix, vertex))

    object.mesh.triangles.forEach(([indexA, indexB, indexC], triangleIndex) => {
      const worldA = transformedVertices[indexA]
      const worldB = transformedVertices[indexB]
      const worldC = transformedVertices[indexC]
      const centroid: Vec3 = [
        (worldA[0] + worldB[0] + worldC[0]) / 3,
        (worldA[1] + worldB[1] + worldC[1]) / 3,
        (worldA[2] + worldB[2] + worldC[2]) / 3,
      ]

      samples.push({
        objectIndex,
        triangleIndex,
        vertices: [worldA, worldB, worldC],
        centroid,
      })
    })
  })

  return samples
}

function resolveOccluderDepth(
  nearestDepths: Float32Array,
  secondaryDepths: Float32Array,
  thetaBins: number,
  phiBins: number,
  thetaPos: number,
  phiPos: number,
  sampleDistance: number,
  depthBias: number,
): number {
  const thetaFloor = Math.floor(thetaPos)
  const phiFloor = Math.floor(phiPos)
  const thetaWeight = thetaPos - thetaFloor
  const phiWeight = phiPos - phiFloor

  const theta0 = wrap(thetaFloor, thetaBins)
  const theta1 = wrap(thetaFloor + 1, thetaBins)
  const phi0 = clamp(phiFloor, 0, phiBins - 1)
  const phi1 = clamp(phiFloor + 1, 0, phiBins - 1)

  const sampleCorner = (thetaIndex: number, phiIndex: number): number => {
    const index = phiIndex * thetaBins + thetaIndex
    const nearest = nearestDepths[index]
    const secondary = secondaryDepths[index]
    return Math.abs(sampleDistance - nearest) <= depthBias ? secondary : nearest
  }

  const d00 = sampleCorner(theta0, phi0)
  const d10 = sampleCorner(theta1, phi0)
  const d01 = sampleCorner(theta0, phi1)
  const d11 = sampleCorner(theta1, phi1)

  const w00 = (1 - thetaWeight) * (1 - phiWeight)
  const w10 = thetaWeight * (1 - phiWeight)
  const w01 = (1 - thetaWeight) * phiWeight
  const w11 = thetaWeight * phiWeight

  let weightedDepth = 0
  let totalWeight = 0

  if (Number.isFinite(d00)) {
    weightedDepth += d00 * w00
    totalWeight += w00
  }
  if (Number.isFinite(d10)) {
    weightedDepth += d10 * w10
    totalWeight += w10
  }
  if (Number.isFinite(d01)) {
    weightedDepth += d01 * w01
    totalWeight += w01
  }
  if (Number.isFinite(d11)) {
    weightedDepth += d11 * w11
    totalWeight += w11
  }

  if (totalWeight > 0.000001) {
    return weightedDepth / totalWeight
  }

  return Number.POSITIVE_INFINITY
}

function evaluatePointVisibility(
  point: Vec3,
  lightPosition: Vec3,
  nearestDepthBins: Float32Array,
  secondaryDepthBins: Float32Array,
  thetaBins: number,
  phiBins: number,
  depthBias: number,
  minimumVisibility: number,
): number {
  const vectorToPoint = [
    point[0] - lightPosition[0],
    point[1] - lightPosition[1],
    point[2] - lightPosition[2],
  ] as Vec3
  const distance = Math.hypot(vectorToPoint[0], vectorToPoint[1], vectorToPoint[2])
  const [thetaPos, phiPos] = directionToUv(vectorToPoint, thetaBins, phiBins)
  const occluderDepth = resolveOccluderDepth(
    nearestDepthBins,
    secondaryDepthBins,
    thetaBins,
    phiBins,
    thetaPos,
    phiPos,
    distance,
    depthBias,
  )
  const dynamicBias = depthBias + distance * 0.018
  const delta = distance - occluderDepth
  return clamp(1 - delta / Math.max(0.0001, dynamicBias * 2), minimumVisibility, 1)
}

export function computePointLightShadowVisibility(
  objects: SceneObject[],
  lights: PointLightInput[],
  quality: number,
  smoothShadows = false,
): ObjectShadowVisibility[] {
  const clampedQuality = clamp(quality, 0, 2)
  const normalizedQuality = clampedQuality / 2
  const visibilityByObject = objects.map((object) => ({
    flat: new Array(object.mesh.triangles.length).fill(0).map(() => new Array(MAX_POINT_LIGHTS).fill(1)),
    perVertex: new Array(object.mesh.triangles.length)
      .fill(0)
      .map(() => [new Array(MAX_POINT_LIGHTS).fill(1), new Array(MAX_POINT_LIGHTS).fill(1), new Array(MAX_POINT_LIGHTS).fill(1)] as [number[], number[], number[]]),
  }))

  if (lights.length === 0 || clampedQuality <= 0.001) {
    return visibilityByObject
  }

  const samples = buildTriangleSamples(objects)
  if (samples.length === 0) {
    return visibilityByObject
  }

  const thetaBins = Math.max(20, Math.round(40 + normalizedQuality * 240))
  const phiBins = Math.max(6, Math.round(thetaBins * 0.5))
  const depthBias = 0.04 + (1 - normalizedQuality) * 0.08
  const minimumVisibility = 0.06 + (1 - normalizedQuality) * 0.14
  const lightCount = Math.min(lights.length, MAX_POINT_LIGHTS)

  for (let lightIndex = 0; lightIndex < lightCount; lightIndex += 1) {
    const light = lights[lightIndex]
    if (Math.max(0, light.intensity) <= 0) {
      continue
    }

    const nearestDepthBins = new Float32Array(thetaBins * phiBins)
    const secondaryDepthBins = new Float32Array(thetaBins * phiBins)
    nearestDepthBins.fill(Number.POSITIVE_INFINITY)
    secondaryDepthBins.fill(Number.POSITIVE_INFINITY)

    for (const sample of samples) {
      for (const point of [sample.vertices[0], sample.vertices[1], sample.vertices[2], sample.centroid]) {
        const vectorToTriangle = [
          point[0] - light.position[0],
          point[1] - light.position[1],
          point[2] - light.position[2],
        ] as Vec3
        const distance = Math.hypot(vectorToTriangle[0], vectorToTriangle[1], vectorToTriangle[2])
        const [thetaPos, phiPos] = directionToUv(vectorToTriangle, thetaBins, phiBins)
        const thetaIndex = wrap(Math.round(thetaPos), thetaBins)
        const phiIndex = clamp(Math.round(phiPos), 0, phiBins - 1)
        const binIndex = phiIndex * thetaBins + thetaIndex
        const nearest = nearestDepthBins[binIndex]
        const secondary = secondaryDepthBins[binIndex]

        if (distance < nearest) {
          secondaryDepthBins[binIndex] = nearest
          nearestDepthBins[binIndex] = distance
        } else if (distance < secondary) {
          secondaryDepthBins[binIndex] = distance
        }
      }
    }

    for (const sample of samples) {
      const vertexVisibility: [number, number, number] = [
        evaluatePointVisibility(
          sample.vertices[0],
          light.position,
          nearestDepthBins,
          secondaryDepthBins,
          thetaBins,
          phiBins,
          depthBias,
          minimumVisibility,
        ),
        evaluatePointVisibility(
          sample.vertices[1],
          light.position,
          nearestDepthBins,
          secondaryDepthBins,
          thetaBins,
          phiBins,
          depthBias,
          minimumVisibility,
        ),
        evaluatePointVisibility(
          sample.vertices[2],
          light.position,
          nearestDepthBins,
          secondaryDepthBins,
          thetaBins,
          phiBins,
          depthBias,
          minimumVisibility,
        ),
      ]
      const centroidVisibility = evaluatePointVisibility(
        sample.centroid,
        light.position,
        nearestDepthBins,
        secondaryDepthBins,
        thetaBins,
        phiBins,
        depthBias,
        minimumVisibility,
      )
      const bestVisibility = Math.max(
        vertexVisibility[0],
        vertexVisibility[1],
        vertexVisibility[2],
        centroidVisibility,
      )

      const objectVisibility = visibilityByObject[sample.objectIndex]
      objectVisibility.flat[sample.triangleIndex][lightIndex] = bestVisibility
      if (smoothShadows) {
        objectVisibility.perVertex[sample.triangleIndex][0][lightIndex] = vertexVisibility[0]
        objectVisibility.perVertex[sample.triangleIndex][1][lightIndex] = vertexVisibility[1]
        objectVisibility.perVertex[sample.triangleIndex][2][lightIndex] = vertexVisibility[2]
      }
    }
  }

  return visibilityByObject
}
