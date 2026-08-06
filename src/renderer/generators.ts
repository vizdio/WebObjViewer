import type { Mesh } from './mesh'
import type { Vec3 } from './math'
import { parseObjMesh } from './obj'
import teapotObj from '../objects/teapot.obj?raw'

// ---------------------------------------------------------------------------
// Seeded random number generator for deterministic fractal generation
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Shared construction helpers
// ---------------------------------------------------------------------------

// Creates a surface of revolution from a [radius, height] profile.
// Rows go bottom -> top, theta goes counter-clockwise when viewed from +Y.
function addRevolutionSurface(
  vertices: Vec3[],
  triangles: Array<[number, number, number]>,
  profile: Array<[number, number]>,
  segments: number,
  closeBottom: boolean,
  closeTop: boolean,
): void {
  const rows = profile.length
  const baseIndex = vertices.length

  for (let row = 0; row < rows; row++) {
    const [radius, height] = profile[row]
    for (let seg = 0; seg <= segments; seg++) {
      const theta = (seg / segments) * Math.PI * 2
      vertices.push([Math.cos(theta) * radius, height, Math.sin(theta) * radius])
    }
  }

  const ringStart = (row: number) => baseIndex + row * (segments + 1)

  // Side quads (outward-facing winding for P = [cos, y, sin])
  for (let row = 0; row < rows - 1; row++) {
    for (let seg = 0; seg < segments; seg++) {
      const a = ringStart(row) + seg
      const b = ringStart(row) + seg + 1
      const c = ringStart(row + 1) + seg
      const d = ringStart(row + 1) + seg + 1
      triangles.push([a, c, b], [c, d, b])
    }
  }

  if (closeBottom && profile[0][0] > 0.001) {
    const center = vertices.length
    vertices.push([0, profile[0][1], 0])
    const start = ringStart(0)
    for (let seg = 0; seg < segments; seg++) {
      triangles.push([center, start + seg, start + seg + 1])
    }
  }

  if (closeTop && profile[rows - 1][0] > 0.001) {
    const center = vertices.length
    vertices.push([0, profile[rows - 1][1], 0])
    const start = ringStart(rows - 1)
    for (let seg = 0; seg < segments; seg++) {
      triangles.push([center, start + seg + 1, start + seg])
    }
  }
}

// Sweeps a circular tube along precomputed samples (center + normalized tangent).
function addTubeSamples(
  vertices: Vec3[],
  triangles: Array<[number, number, number]>,
  samples: Array<{ center: Vec3; tangent: Vec3 }>,
  radius: number,
  tubeSegments: number,
): void {
  const base = vertices.length

  for (let s = 0; s < samples.length; s++) {
    const { center, tangent } = samples[s]
    const tan = tangent

    const reference: Vec3 = Math.abs(tan[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const crossR: Vec3 = [
      tan[1] * reference[2] - tan[2] * reference[1],
      tan[2] * reference[0] - tan[0] * reference[2],
      tan[0] * reference[1] - tan[1] * reference[0],
    ]
    const crossLen = Math.sqrt(crossR[0] ** 2 + crossR[1] ** 2 + crossR[2] ** 2)
    const normal: Vec3 = [crossR[0] / crossLen, crossR[1] / crossLen, crossR[2] / crossLen]
    const binormal: Vec3 = [
      tan[1] * normal[2] - tan[2] * normal[1],
      tan[2] * normal[0] - tan[0] * normal[2],
      tan[0] * normal[1] - tan[1] * normal[0],
    ]

    for (let tube = 0; tube <= tubeSegments; tube++) {
      const phi = (tube / tubeSegments) * Math.PI * 2
      const cp = Math.cos(phi)
      const sp = Math.sin(phi)
      vertices.push([
        center[0] + radius * (cp * normal[0] + sp * binormal[0]),
        center[1] + radius * (cp * normal[1] + sp * binormal[1]),
        center[2] + radius * (cp * normal[2] + sp * binormal[2]),
      ])
    }
  }

  for (let s = 0; s < samples.length - 1; s++) {
    for (let tube = 0; tube < tubeSegments; tube++) {
      const a = base + s * (tubeSegments + 1) + tube
      const b = a + tubeSegments + 1
      triangles.push([a, a + 1, b], [b, a + 1, b + 1])
    }
  }
}

// Appends a sphere centered at `center` with outward-facing winding.
function addSphereToMesh(
  vertices: Vec3[],
  triangles: Array<[number, number, number]>,
  center: Vec3,
  radius: number,
  segments = 16,
  rings = 10,
): void {
  const base = vertices.length

  for (let ring = 0; ring <= rings; ring++) {
    const phi = (ring / rings) * Math.PI
    const y = Math.cos(phi) * radius + center[1]
    const ringRadius = Math.sin(phi) * radius
    for (let seg = 0; seg <= segments; seg++) {
      const theta = (seg / segments) * Math.PI * 2
      vertices.push([
        Math.cos(theta) * ringRadius + center[0],
        y,
        Math.sin(theta) * ringRadius + center[2],
      ])
    }
  }

  for (let ring = 0; ring < rings; ring++) {
    for (let seg = 0; seg < segments; seg++) {
      const cur = base + ring * (segments + 1) + seg
      const next = cur + segments + 1
      triangles.push([cur, cur + 1, next])
      triangles.push([next, cur + 1, next + 1])
    }
  }
}

// Appends a cone with outward-facing winding.
function addConeToMesh(
  vertices: Vec3[],
  triangles: Array<[number, number, number]>,
  apex: Vec3,
  baseCenter: Vec3,
  baseRadius: number,
  segments = 16,
): void {
  const apexIndex = vertices.length
  vertices.push(apex)

  const baseCenterIndex = vertices.length
  vertices.push(baseCenter)

  for (let seg = 0; seg <= segments; seg++) {
    const theta = (seg / segments) * Math.PI * 2
    vertices.push([
      baseCenter[0] + Math.cos(theta) * baseRadius,
      baseCenter[1],
      baseCenter[2] + Math.sin(theta) * baseRadius,
    ])
  }

  const ringStart = baseCenterIndex + 1
  for (let seg = 0; seg < segments; seg++) {
    const a = ringStart + seg
    const b = ringStart + seg + 1
    triangles.push([apexIndex, b, a])
    triangles.push([baseCenterIndex, a, b])
  }
}

// ---------------------------------------------------------------------------
// Primitive shapes
// ---------------------------------------------------------------------------

export function createSphereMesh(
  name = 'Sphere',
  color = '#7dd3fc',
  radius = 1,
  segments = 24,
  rings = 16,
): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  for (let ring = 0; ring <= rings; ring++) {
    const phi = (ring / rings) * Math.PI
    const y = Math.cos(phi) * radius
    const ringRadius = Math.sin(phi) * radius

    for (let segment = 0; segment <= segments; segment++) {
      const theta = (segment / segments) * Math.PI * 2
      const x = Math.cos(theta) * ringRadius
      const z = Math.sin(theta) * ringRadius
      vertices.push([x, y, z])
    }
  }

  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const current = ring * (segments + 1) + segment
      const next = current + segments + 1

      // Correct outward-facing winding
      triangles.push([current, current + 1, next])
      triangles.push([next, current + 1, next + 1])
    }
  }

  return { name, color, vertices, triangles }
}

export function createCylinderMesh(
  name = 'Cylinder',
  color = '#fbbf24',
  radius = 1,
  height = 2,
  segments = 24,
): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  const halfHeight = height / 2

  // Top center
  vertices.push([0, halfHeight, 0])
  // Bottom center
  vertices.push([0, -halfHeight, 0])

  const topCenterIndex = 0
  const bottomCenterIndex = 1

  // Top ring (all top vertices first)
  for (let segment = 0; segment <= segments; segment++) {
    const theta = (segment / segments) * Math.PI * 2
    vertices.push([Math.cos(theta) * radius, halfHeight, Math.sin(theta) * radius])
  }

  // Bottom ring (all bottom vertices after)
  for (let segment = 0; segment <= segments; segment++) {
    const theta = (segment / segments) * Math.PI * 2
    vertices.push([Math.cos(theta) * radius, -halfHeight, Math.sin(theta) * radius])
  }

  const topRingStart = 2
  const bottomRingStart = 2 + segments + 1

  // Side faces (outward-facing winding)
  for (let segment = 0; segment < segments; segment++) {
    const topA = topRingStart + segment
    const topB = topRingStart + segment + 1
    const bottomA = bottomRingStart + segment
    const bottomB = bottomRingStart + segment + 1

    triangles.push([topA, topB, bottomA])
    triangles.push([bottomA, topB, bottomB])
  }

  // Top cap
  for (let segment = 0; segment < segments; segment++) {
    const a = topRingStart + segment
    const b = topRingStart + segment + 1
    triangles.push([topCenterIndex, b, a])
  }

  // Bottom cap
  for (let segment = 0; segment < segments; segment++) {
    const a = bottomRingStart + segment
    const b = bottomRingStart + segment + 1
    triangles.push([bottomCenterIndex, a, b])
  }

  return { name, color, vertices, triangles }
}

export function createConeMesh(
  name = 'Cone',
  color = '#a78bfa',
  radius = 1,
  height = 2,
  segments = 24,
): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  const halfHeight = height / 2

  // Apex
  vertices.push([0, halfHeight, 0])
  // Base center
  vertices.push([0, -halfHeight, 0])

  const apexIndex = 0
  const baseCenterIndex = 1

  for (let segment = 0; segment <= segments; segment++) {
    const theta = (segment / segments) * Math.PI * 2
    const x = Math.cos(theta) * radius
    const z = Math.sin(theta) * radius
    vertices.push([x, -halfHeight, z])
  }

  const baseRingStart = 2

  // Side faces (outward-facing winding)
  for (let segment = 0; segment < segments; segment++) {
    const a = baseRingStart + segment
    const b = baseRingStart + segment + 1
    triangles.push([apexIndex, b, a])
  }

  // Base cap (outward-facing winding)
  for (let segment = 0; segment < segments; segment++) {
    const a = baseRingStart + segment
    const b = baseRingStart + segment + 1
    triangles.push([baseCenterIndex, a, b])
  }

  return { name, color, vertices, triangles }
}

export function createPlaneMesh(
  name = 'Plane',
  color = '#34d399',
  width = 2,
  depth = 2,
  segments = 1,
): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  const halfWidth = width / 2
  const halfDepth = depth / 2

  for (let row = 0; row <= segments; row++) {
    const z = -halfDepth + (row / segments) * depth
    for (let col = 0; col <= segments; col++) {
      const x = -halfWidth + (col / segments) * width
      vertices.push([x, 0, z])
    }
  }

  for (let row = 0; row < segments; row++) {
    for (let col = 0; col < segments; col++) {
      const current = row * (segments + 1) + col
      const next = current + segments + 1

      triangles.push([current, next, current + 1])
      triangles.push([next, next + 1, current + 1])
    }
  }

  return { name, color, vertices, triangles }
}

export function createIcosahedronMesh(name = 'Icosahedron', color = '#f472b6'): Mesh {
  const t = (1 + Math.sqrt(5)) / 2

  const vertices: Vec3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ]

  // Normalize vertices to unit sphere
  const normalized = vertices.map(([x, y, z]) => {
    const length = Math.sqrt(x * x + y * y + z * z)
    return [x / length, y / length, z / length] as Vec3
  })

  const triangles: Array<[number, number, number]> = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ]

  return { name, color, vertices: normalized, triangles }
}

export function createDodecahedronMesh(name = 'Dodecahedron', color = '#fb923c'): Mesh {
  const t = (1 + Math.sqrt(5)) / 2

  // Icosahedron vertices
  const icoVertices: Vec3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ]

  // Icosahedron faces (outward winding)
  const icoFaces: Array<[number, number, number]> = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ]

  // Each face of the icosahedron becomes a vertex of the dodecahedron (dual)
  const dodecaVertices: Vec3[] = icoFaces.map(([a, b, c]) => {
    const va = icoVertices[a]
    const vb = icoVertices[b]
    const vc = icoVertices[c]
    const centroid: Vec3 = [
      (va[0] + vb[0] + vc[0]) / 3,
      (va[1] + vb[1] + vc[1]) / 3,
      (va[2] + vb[2] + vc[2]) / 3,
    ]
    const length = Math.sqrt(centroid[0] ** 2 + centroid[1] ** 2 + centroid[2] ** 2)
    return [centroid[0] / length, centroid[1] / length, centroid[2] / length] as Vec3
  })

  // For each icosahedron vertex, find the faces that contain it
  const facesAroundVertex: number[][] = icoVertices.map((_, vi) => {
    const result: number[] = []
    icoFaces.forEach((face, fi) => {
      if (face[0] === vi || face[1] === vi || face[2] === vi) {
        result.push(fi)
      }
    })
    return result
  })

  // Order the faces around each vertex by following shared edges
  const orderedFaces = facesAroundVertex.map((faces) => {
    if (faces.length === 0) {
      return faces
    }
    const ordered: number[] = [faces[0]]
    const remaining = new Set(faces.slice(1))

    while (remaining.size > 0) {
      const lastFaceIndex = ordered[ordered.length - 1]
      const lastFace = icoFaces[lastFaceIndex]
      let found = false
      for (const candidateIndex of remaining) {
        const candidate = icoFaces[candidateIndex]
        const shared = lastFace.filter((v) => candidate.includes(v))
        if (shared.length === 2) {
          ordered.push(candidateIndex)
          remaining.delete(candidateIndex)
          found = true
          break
        }
      }
      if (!found) {
        break
      }
    }

    return ordered
  })

  // Build triangles for each pentagonal face, ensuring outward-facing normals
  const triangles: Array<[number, number, number]> = []
  for (const face of orderedFaces) {
    if (face.length < 3) {
      continue
    }

    // Check winding of the first triangle
    const v0 = dodecaVertices[face[0]]
    const v1 = dodecaVertices[face[1]]
    const v2 = dodecaVertices[face[2]]

    const e1: Vec3 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]]
    const e2: Vec3 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]]

    const normal: Vec3 = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ]

    const centroid: Vec3 = [
      (v0[0] + v1[0] + v2[0]) / 3,
      (v0[1] + v1[1] + v2[1]) / 3,
      (v0[2] + v1[2] + v2[2]) / 3,
    ]

    const dot = normal[0] * centroid[0] + normal[1] * centroid[1] + normal[2] * centroid[2]

    if (dot < 0) {
      // Flip winding
      triangles.push([face[0], face[2], face[1]])
      if (face.length >= 4) {
        triangles.push([face[0], face[3], face[2]])
      }
      if (face.length >= 5) {
        triangles.push([face[0], face[4], face[3]])
      }
    } else {
      triangles.push([face[0], face[1], face[2]])
      if (face.length >= 4) {
        triangles.push([face[0], face[2], face[3]])
      }
      if (face.length >= 5) {
        triangles.push([face[0], face[3], face[4]])
      }
    }
  }

  return { name, color, vertices: dodecaVertices, triangles }
}

// ---------------------------------------------------------------------------
// Complex shapes
// ---------------------------------------------------------------------------

export function createTorusMesh(
  name = 'Torus',
  color = '#f87171',
  majorRadius = 1,
  minorRadius = 0.4,
  majorSegments = 32,
  minorSegments = 16,
): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  for (let major = 0; major <= majorSegments; major++) {
    const majorAngle = (major / majorSegments) * Math.PI * 2
    const cosMajor = Math.cos(majorAngle)
    const sinMajor = Math.sin(majorAngle)

    for (let minor = 0; minor <= minorSegments; minor++) {
      const minorAngle = (minor / minorSegments) * Math.PI * 2
      const cosMinor = Math.cos(minorAngle)
      const sinMinor = Math.sin(minorAngle)

      const x = (majorRadius + minorRadius * cosMinor) * cosMajor
      const y = minorRadius * sinMinor
      const z = (majorRadius + minorRadius * cosMinor) * sinMajor

      vertices.push([x, y, z])
    }
  }

  for (let major = 0; major < majorSegments; major++) {
    for (let minor = 0; minor < minorSegments; minor++) {
      const current = major * (minorSegments + 1) + minor
      const next = current + minorSegments + 1

      // Outward-facing winding
      triangles.push([current, current + 1, next])
      triangles.push([next, current + 1, next + 1])
    }
  }

  return { name, color, vertices, triangles }
}

export function createTorusKnotMesh(
  name = 'Torus Knot',
  color = '#c084fc',
  radius = 1,
  tubeRadius = 0.3,
  p = 2,
  q = 3,
  segments = 200,
  tubeSegments = 12,
): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  const majorRadius = 2
  const minorRadius = 1

  for (let segment = 0; segment <= segments; segment++) {
    const t = (segment / segments) * Math.PI * 2
    const u = p * t
    const v = q * t

    // Torus knot center point
    const center: Vec3 = [
      (majorRadius + minorRadius * Math.cos(v)) * Math.cos(u),
      (majorRadius + minorRadius * Math.cos(v)) * Math.sin(u),
      minorRadius * Math.sin(v),
    ]

    // Use the torus's natural frame: radial direction and vertical direction
    const radial: Vec3 = [Math.cos(u), Math.sin(u), 0]
    const vertical: Vec3 = [0, 0, 1]

    for (let tube = 0; tube <= tubeSegments; tube++) {
      const tubeAngle = (tube / tubeSegments) * Math.PI * 2
      const cosTube = Math.cos(tubeAngle)
      const sinTube = Math.sin(tubeAngle)

      const x = center[0] + tubeRadius * (cosTube * radial[0] + sinTube * vertical[0])
      const y = center[1] + tubeRadius * (cosTube * radial[1] + sinTube * vertical[1])
      const z = center[2] + tubeRadius * (cosTube * radial[2] + sinTube * vertical[2])

      vertices.push([x * radius, y * radius, z * radius])
    }
  }

  for (let segment = 0; segment < segments; segment++) {
    for (let tube = 0; tube < tubeSegments; tube++) {
      const current = segment * (tubeSegments + 1) + tube
      const next = current + tubeSegments + 1

      // Outward-facing winding for the torus frame
      triangles.push([current, next, current + 1])
      triangles.push([next, next + 1, current + 1])
    }
  }

  return { name, color, vertices, triangles }
}

export function createHelixMesh(
  name = 'Helix',
  color = '#38bdf8',
  radius = 0.8,
  height = 2.5,
  turns = 4,
  segments = 200,
  tubeRadius = 0.12,
  tubeSegments = 8,
): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  const totalAngle = turns * Math.PI * 2

  for (let segment = 0; segment <= segments; segment++) {
    const t = segment / segments
    const angle = t * totalAngle
    const y = -height / 2 + t * height

    const center: Vec3 = [Math.cos(angle) * radius, y, Math.sin(angle) * radius]

    // Tangent direction
    const tangent: Vec3 = [
      -Math.sin(angle) * radius * totalAngle,
      height,
      Math.cos(angle) * radius * totalAngle,
    ]
    const tangentLength = Math.sqrt(tangent[0] ** 2 + tangent[1] ** 2 + tangent[2] ** 2)
    const tan: Vec3 = [tangent[0] / tangentLength, tangent[1] / tangentLength, tangent[2] / tangentLength]

    // Normal points toward the helix axis
    const normal: Vec3 = [-Math.cos(angle), 0, -Math.sin(angle)]

    // Binormal = tangent × normal (already normalized since tan and normal are orthonormal)
    const binormal: Vec3 = [
      tan[1] * normal[2] - tan[2] * normal[1],
      tan[2] * normal[0] - tan[0] * normal[2],
      tan[0] * normal[1] - tan[1] * normal[0],
    ]

    for (let tube = 0; tube <= tubeSegments; tube++) {
      const tubeAngle = (tube / tubeSegments) * Math.PI * 2
      const cosTube = Math.cos(tubeAngle)
      const sinTube = Math.sin(tubeAngle)

      const x = center[0] + tubeRadius * (cosTube * normal[0] + sinTube * binormal[0])
      const y2 = center[1] + tubeRadius * (cosTube * normal[1] + sinTube * binormal[1])
      const z = center[2] + tubeRadius * (cosTube * normal[2] + sinTube * binormal[2])

      vertices.push([x, y2, z])
    }
  }

  for (let segment = 0; segment < segments; segment++) {
    for (let tube = 0; tube < tubeSegments; tube++) {
      const current = segment * (tubeSegments + 1) + tube
      const next = current + tubeSegments + 1

      // Outward-facing winding
      triangles.push([current, current + 1, next])
      triangles.push([next, current + 1, next + 1])
    }
  }

  return { name, color, vertices, triangles }
}

// ---------------------------------------------------------------------------
// Fun shapes
// ---------------------------------------------------------------------------

// The Utah Teapot uses the actual teapot OBJ geometry from
// https://github.com/jaz303/utah-teapot/blob/master/teapot.obj
export function createUtahTeapotMesh(name = 'Utah Teapot', color = '#fda4af'): Mesh {
  return parseObjMesh(teapotObj, name, color)
}

// Parametric Klein bottle (Paul Bourke's figure-8 parametrization).
export function createKleinBottleMesh(name = 'Klein Bottle', color = '#818cf8'): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []
  const segmentsU = 64
  const segmentsV = 24
  const a = 2.2

  for (let u = 0; u <= segmentsU; u++) {
    const uu = (u / segmentsU) * Math.PI * 2
    const cuHalf = Math.cos(uu / 2)
    const suHalf = Math.sin(uu / 2)
    const cu = Math.cos(uu)
    const su = Math.sin(uu)
    for (let v = 0; v <= segmentsV; v++) {
      const vv = (v / segmentsV) * Math.PI * 2
      const sv = Math.sin(vv)
      const s2v = Math.sin(2 * vv)
      const r = a + cuHalf * sv - suHalf * s2v
      vertices.push([
        r * cu,
        r * su,
        suHalf * sv + cuHalf * s2v,
      ])
    }
  }

  for (let u = 0; u < segmentsU; u++) {
    for (let v = 0; v < segmentsV; v++) {
      const cur = u * (segmentsV + 1) + v
      const next = cur + segmentsV + 1
      triangles.push([cur, cur + 1, next])
      triangles.push([next, cur + 1, next + 1])
    }
  }

  return { name, color, vertices, triangles, doubleSided: true }
}

// Parametric Mobius strip.
export function createMobiusStripMesh(name = 'Mobius Strip', color = '#60a5fa'): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []
  const segmentsU = 96
  const segmentsV = 8
  const halfWidth = 0.35

  for (let u = 0; u <= segmentsU; u++) {
    const uu = (u / segmentsU) * Math.PI * 2
    const cuHalf = Math.cos(uu / 2)
    const suHalf = Math.sin(uu / 2)
    const cu = Math.cos(uu)
    const su = Math.sin(uu)
    for (let v = 0; v <= segmentsV; v++) {
      const t = (v / segmentsV) * 2 - 1 // [-1, 1]
      const halfT = t * halfWidth
      const radius = 1 + halfT * cuHalf
      vertices.push([radius * cu, radius * su, halfT * suHalf])
    }
  }

  for (let u = 0; u < segmentsU; u++) {
    for (let v = 0; v < segmentsV; v++) {
      const cur = u * (segmentsV + 1) + v
      const next = cur + segmentsV + 1
      triangles.push([cur, cur + 1, next])
      triangles.push([next, cur + 1, next + 1])
    }
  }

  return { name, color, vertices, triangles, doubleSided: true }
}

// Heart formed from two spherical lobes and a bottom cone point.
export function createHeartMesh(name = 'Heart', color = '#f87171'): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  // Two overlapping lobes
  addSphereToMesh(vertices, triangles, [-0.3, 0.42, 0], 0.46, 18, 12)
  addSphereToMesh(vertices, triangles, [0.3, 0.42, 0], 0.46, 18, 12)
  // Bottom point
  addConeToMesh(vertices, triangles, [0, -0.6, 0], [0, 0.02, 0], 0.4, 18)

  return { name, color, vertices, triangles }
}

// Bowling pin built from a profile of revolution.
export function createBowlingPinMesh(name = 'Bowling Pin', color = '#fb7185'): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  addRevolutionSurface(
    vertices,
    triangles,
    [
      [0.0, -1.0],
      [0.26, -1.0],
      [0.29, -0.85],
      [0.16, -0.55],
      [0.14, -0.35],
      [0.2, -0.1],
      [0.22, 0.1],
      [0.2, 0.28],
      [0.12, 0.45],
      [0.1, 0.62],
      [0.12, 0.8],
      [0.1, 0.95],
      [0.0, 1.0],
    ],
    24,
    false,
    false,
  )

  return { name, color, vertices, triangles }
}

// Gear with teeth and a center hole.
export function createGearMesh(name = 'Gear', color = '#94a3b8'): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  const teeth = 14
  const outerRadius = 1.0
  const innerRadius = 0.68
  const hubRadius = 0.22
  const thickness = 0.22
  const half = thickness / 2

  const toothAngle = (Math.PI * 2) / teeth
  const profile: Array<{ angle: number; radius: number }> = []
  for (let i = 0; i < teeth; i++) {
    const base = i * toothAngle
    profile.push({ angle: base, radius: innerRadius })
    profile.push({ angle: base + toothAngle * 0.15, radius: innerRadius })
    profile.push({ angle: base + toothAngle * 0.25, radius: outerRadius })
    profile.push({ angle: base + toothAngle * 0.75, radius: outerRadius })
    profile.push({ angle: base + toothAngle * 0.85, radius: innerRadius })
  }

  const n = profile.length

  const toXY = (p: { angle: number; radius: number }): [number, number] => [
    Math.cos(p.angle) * p.radius,
    Math.sin(p.angle) * p.radius,
  ]

  // Vertex layout:
  // 0..n-1      outer profile at z = +half
  // n..2n-1     hub profile   at z = +half
  // 2n..3n-1    outer profile at z = -half
  // 3n..4n-1    hub profile   at z = -half
  for (const p of profile) {
    const [x, y] = toXY(p)
    vertices.push([x, y, half])
  }
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2
    vertices.push([Math.cos(angle) * hubRadius, Math.sin(angle) * hubRadius, half])
  }
  for (const p of profile) {
    const [x, y] = toXY(p)
    vertices.push([x, y, -half])
  }
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2
    vertices.push([Math.cos(angle) * hubRadius, Math.sin(angle) * hubRadius, -half])
  }

  // Front face (normal +Z): ring between outer and hub
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n
    triangles.push([i, next, n + i])
    triangles.push([next, n + next, n + i])
  }

  // Back face (normal -Z): reversed
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n
    triangles.push([2 * n + next, 2 * n + i, 3 * n + i])
    triangles.push([3 * n + next, 2 * n + next, 3 * n + i])
  }

  // Outer side faces (outward) - same pattern as cylinder sides
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n
    triangles.push([i, next, 2 * n + i])
    triangles.push([2 * n + i, next, 2 * n + next])
  }

  // Hub inner side faces (pointing toward the hole)
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n
    triangles.push([n + i, 3 * n + i, n + next])
    triangles.push([3 * n + i, 3 * n + next, n + next])
  }

  return { name, color, vertices, triangles }
}

// Five-pointed star prism.
export function createStarMesh(name = 'Star', color = '#facc15'): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  const points = 5
  const outerRadius = 1.0
  const innerRadius = 0.42
  const thickness = 0.3
  const half = thickness / 2

  const n = points * 2
  const radii: number[] = []
  for (let i = 0; i < points; i++) {
    radii.push(outerRadius, innerRadius)
  }

  // Front vertices (z = +half), then back vertices (z = -half)
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2
    vertices.push([Math.cos(angle) * radii[i], Math.sin(angle) * radii[i], half])
  }
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2
    vertices.push([Math.cos(angle) * radii[i], Math.sin(angle) * radii[i], -half])
  }

  // Front face fan (normal +Z)
  const frontCenter = vertices.length
  vertices.push([0, 0, half])
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n
    triangles.push([frontCenter, i, next])
  }

  // Back face fan (normal -Z)
  const backCenter = vertices.length
  vertices.push([0, 0, -half])
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n
    triangles.push([backCenter, n + next, n + i])
  }

  // Side faces (outward)
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n
    triangles.push([i, next, n + i])
    triangles.push([n + i, next, n + next])
  }

  return { name, color, vertices, triangles }
}

// ---------------------------------------------------------------------------
// Advanced 3D random fractals
// ---------------------------------------------------------------------------

export function createMengerSpongeMesh(
  name = 'Menger Sponge',
  color = '#fbbf24',
  iterations = 2,
  size = 2,
): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  const addBox = (minX: number, minY: number, minZ: number, boxSize: number) => {
    const maxX = minX + boxSize
    const maxY = minY + boxSize
    const maxZ = minZ + boxSize

    const baseIndex = vertices.length

    // 8 corners
    vertices.push(
      [minX, minY, minZ],
      [maxX, minY, minZ],
      [maxX, maxY, minZ],
      [minX, maxY, minZ],
      [minX, minY, maxZ],
      [maxX, minY, maxZ],
      [maxX, maxY, maxZ],
      [minX, maxY, maxZ],
    )

    // 6 faces, 2 triangles each (same winding as the cube)
    const faceTriangles: Array<[number, number, number]> = [
      [0, 2, 1],
      [0, 3, 2],
      [4, 5, 6],
      [4, 6, 7],
      [0, 1, 5],
      [0, 5, 4],
      [2, 3, 7],
      [2, 7, 6],
      [0, 4, 7],
      [0, 7, 3],
      [1, 2, 6],
      [1, 6, 5],
    ]

    for (const [a, b, c] of faceTriangles) {
      triangles.push([baseIndex + a, baseIndex + b, baseIndex + c])
    }
  }

  const buildSponge = (
    minX: number,
    minY: number,
    minZ: number,
    boxSize: number,
    depth: number,
  ) => {
    if (depth === 0) {
      addBox(minX, minY, minZ, boxSize)
      return
    }

    const third = boxSize / 3

    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        for (let z = 0; z < 3; z++) {
          // Skip the center and the 6 face-center cubes
          const isCenter = x === 1 && y === 1 && z === 1
          const isFaceCenter =
            (x === 1 && y === 1 && z !== 1) ||
            (x === 1 && z === 1 && y !== 1) ||
            (y === 1 && z === 1 && x !== 1)

          if (isCenter || isFaceCenter) {
            continue
          }

          buildSponge(
            minX + x * third,
            minY + y * third,
            minZ + z * third,
            third,
            depth - 1,
          )
        }
      }
    }
  }

  buildSponge(-size / 2, -size / 2, -size / 2, size, iterations)

  return { name, color, vertices, triangles }
}

export function createSierpinskiTetrahedronMesh(
  name = 'Sierpinski Tetrahedron',
  color = '#4ade80',
  iterations = 3,
  size = 2,
): Mesh {
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  const addTetrahedron = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => {
    const baseIndex = vertices.length
    vertices.push(a, b, c, d)

    // Helper to add a face with correct outward-facing winding.
    // The face (v0, v1, v2) is opposite the vertex `opposite`.
    const addFace = (v0: number, v1: number, v2: number, opposite: Vec3) => {
      const p0 = vertices[baseIndex + v0]
      const p1 = vertices[baseIndex + v1]
      const p2 = vertices[baseIndex + v2]

      const e1: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
      const e2: Vec3 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]

      const normal: Vec3 = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ]

      // Vector from p0 to the opposite vertex
      const toOpposite: Vec3 = [
        opposite[0] - p0[0],
        opposite[1] - p0[1],
        opposite[2] - p0[2],
      ]

      const dot = normal[0] * toOpposite[0] + normal[1] * toOpposite[1] + normal[2] * toOpposite[2]

      if (dot < 0) {
        // Normal points away from the opposite vertex (outward) - keep winding
        triangles.push([baseIndex + v0, baseIndex + v1, baseIndex + v2])
      } else {
        // Normal points toward the opposite vertex (inward) - flip winding
        triangles.push([baseIndex + v0, baseIndex + v2, baseIndex + v1])
      }
    }

    // Four faces, each opposite one vertex
    addFace(0, 1, 2, d) // face (a, b, c) opposite d
    addFace(0, 1, 3, c) // face (a, b, d) opposite c
    addFace(0, 2, 3, b) // face (a, c, d) opposite b
    addFace(1, 2, 3, a) // face (b, c, d) opposite a
  }

  const midpoint = (a: Vec3, b: Vec3): Vec3 => [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
    (a[2] + b[2]) / 2,
  ]

  const buildTetrahedron = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, depth: number) => {
    if (depth === 0) {
      addTetrahedron(a, b, c, d)
      return
    }

    const ab = midpoint(a, b)
    const ac = midpoint(a, c)
    const ad = midpoint(a, d)
    const bc = midpoint(b, c)
    const bd = midpoint(b, d)
    const cd = midpoint(c, d)

    buildTetrahedron(a, ab, ac, ad, depth - 1)
    buildTetrahedron(b, ab, bc, bd, depth - 1)
    buildTetrahedron(c, ac, bc, cd, depth - 1)
    buildTetrahedron(d, ad, bd, cd, depth - 1)
  }

  const half = size / 2

  const a: Vec3 = [0, half, 0]
  const b: Vec3 = [-half, -half * 0.5, -half * 0.5]
  const c: Vec3 = [half, -half * 0.5, -half * 0.5]
  const d: Vec3 = [0, -half * 0.5, half]

  buildTetrahedron(a, b, c, d, iterations)

  return { name, color, vertices, triangles }
}

export function createFractalTerrainMesh(
  name = 'Fractal Terrain',
  color = '#34d399',
  seed = 42,
  size = 2.4,
  gridSize = 32,
  roughness = 0.6,
): Mesh {
  const random = mulberry32(seed)
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  // Generate height map using diamond-square algorithm
  const mapSize = gridSize + 1
  const heights: number[][] = Array.from({ length: mapSize }, () => new Array<number>(mapSize).fill(0))

  const setHeight = (x: number, y: number, value: number) => {
    heights[y][x] = value
  }

  const getHeight = (x: number, y: number): number => heights[y][x]

  const half = size / 2
  const cellSize = size / gridSize

  // Initialize corners
  setHeight(0, 0, (random() - 0.5) * 0.5)
  setHeight(mapSize - 1, 0, (random() - 0.5) * 0.5)
  setHeight(0, mapSize - 1, (random() - 0.5) * 0.5)
  setHeight(mapSize - 1, mapSize - 1, (random() - 0.5) * 0.5)

  let step = mapSize - 1
  let scale = 1

  while (step > 1) {
    const halfStep = step / 2

    // Diamond step
    for (let y = 0; y < mapSize - 1; y += step) {
      for (let x = 0; x < mapSize - 1; x += step) {
        const avg =
          (getHeight(x, y) +
            getHeight(x + step, y) +
            getHeight(x, y + step) +
            getHeight(x + step, y + step)) /
          4
        const offset = (random() - 0.5) * 2 * scale * roughness
        setHeight(x + halfStep, y + halfStep, avg + offset)
      }
    }

    // Square step
    for (let y = 0; y < mapSize; y += halfStep) {
      for (let x = 0; x < mapSize; x += halfStep) {
        if (
          heights[y][x] !== 0 ||
          (x === 0 && y === 0) ||
          (x === mapSize - 1 && y === 0) ||
          (x === 0 && y === mapSize - 1) ||
          (x === mapSize - 1 && y === mapSize - 1)
        ) {
          continue
        }

        const neighbors: number[] = []
        if (x - halfStep >= 0) neighbors.push(getHeight(x - halfStep, y))
        if (x + halfStep < mapSize) neighbors.push(getHeight(x + halfStep, y))
        if (y - halfStep >= 0) neighbors.push(getHeight(x, y - halfStep))
        if (y + halfStep < mapSize) neighbors.push(getHeight(x, y + halfStep))

        if (neighbors.length > 0) {
          const avg = neighbors.reduce((sum, value) => sum + value, 0) / neighbors.length
          const offset = (random() - 0.5) * 2 * scale * roughness
          setHeight(x, y, avg + offset)
        }
      }
    }

    step = halfStep
    scale *= 0.5
  }

  // Build mesh
  for (let y = 0; y <= gridSize; y++) {
    for (let x = 0; x <= gridSize; x++) {
      const worldX = -half + x * cellSize
      const worldZ = -half + y * cellSize
      const worldY = getHeight(x, y) * 0.5
      vertices.push([worldX, worldY, worldZ])
    }
  }

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const current = y * (gridSize + 1) + x
      const next = current + gridSize + 1

      triangles.push([current, next, current + 1])
      triangles.push([next, next + 1, current + 1])
    }
  }

  return { name, color, vertices, triangles }
}

export function createFractalTreeMesh(
  name = 'Fractal Tree',
  color = '#4ade80',
  seed = 7,
  depth = 5,
  trunkHeight = 1.2,
  branchFactor = 0.7,
  branchAngle = 0.5,
): Mesh {
  const random = mulberry32(seed)
  const vertices: Vec3[] = []
  const triangles: Array<[number, number, number]> = []

  const addBranch = (
    start: Vec3,
    direction: Vec3,
    length: number,
    thickness: number,
    currentDepth: number,
  ) => {
    const end: Vec3 = [
      start[0] + direction[0] * length,
      start[1] + direction[1] * length,
      start[2] + direction[2] * length,
    ]

    // Create a cylinder segment for this branch
    const segments = 6
    const baseIndex = vertices.length

    // Build a frame perpendicular to the direction
    const dirLength = Math.sqrt(direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2)
    const dir: Vec3 = [direction[0] / dirLength, direction[1] / dirLength, direction[2] / dirLength]

    const reference: Vec3 = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const cross1: Vec3 = [
      dir[1] * reference[2] - dir[2] * reference[1],
      dir[2] * reference[0] - dir[0] * reference[2],
      dir[0] * reference[1] - dir[1] * reference[0],
    ]
    const cross1Length = Math.sqrt(cross1[0] ** 2 + cross1[1] ** 2 + cross1[2] ** 2)
    const normal: Vec3 = [cross1[0] / cross1Length, cross1[1] / cross1Length, cross1[2] / cross1Length]

    const binormal: Vec3 = [
      dir[1] * normal[2] - dir[2] * normal[1],
      dir[2] * normal[0] - dir[0] * normal[2],
      dir[0] * normal[1] - dir[1] * normal[0],
    ]

    // Bottom ring
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      const cosA = Math.cos(angle)
      const sinA = Math.sin(angle)
      vertices.push([
        start[0] + thickness * (cosA * normal[0] + sinA * binormal[0]),
        start[1] + thickness * (cosA * normal[1] + sinA * binormal[1]),
        start[2] + thickness * (cosA * normal[2] + sinA * binormal[2]),
      ])
    }

    // Top ring (slightly thinner)
    const topThickness = thickness * 0.85
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      const cosA = Math.cos(angle)
      const sinA = Math.sin(angle)
      vertices.push([
        end[0] + topThickness * (cosA * normal[0] + sinA * binormal[0]),
        end[1] + topThickness * (cosA * normal[1] + sinA * binormal[1]),
        end[2] + topThickness * (cosA * normal[2] + sinA * binormal[2]),
      ])
    }

    // Side faces (outward-facing winding)
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments
      triangles.push([baseIndex + i, baseIndex + next, baseIndex + segments + i])
      triangles.push([baseIndex + segments + i, baseIndex + next, baseIndex + segments + next])
    }

    // Bottom cap
    const bottomCenterIndex = vertices.length
    vertices.push(start)
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments
      triangles.push([bottomCenterIndex, baseIndex + next, baseIndex + i])
    }

    // Top cap
    const topCenterIndex = vertices.length
    vertices.push(end)
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments
      triangles.push([topCenterIndex, baseIndex + segments + i, baseIndex + segments + next])
    }

    // Recurse
    if (currentDepth > 0) {
      const numBranches = 2 + Math.floor(random() * 2)
      for (let i = 0; i < numBranches; i++) {
        const angleOffset = (random() - 0.5) * 0.8
        const spreadAngle = branchAngle + angleOffset

        // Random rotation around the branch axis
        const twistAngle = random() * Math.PI * 2
        const cosT = Math.cos(twistAngle)
        const sinT = Math.sin(twistAngle)

        // Rotate normal and binormal around direction
        const rotatedNormal: Vec3 = [
          normal[0] * cosT + binormal[0] * sinT,
          normal[1] * cosT + binormal[1] * sinT,
          normal[2] * cosT + binormal[2] * sinT,
        ]

        const newDirection: Vec3 = [
          dir[0] * Math.cos(spreadAngle) + rotatedNormal[0] * Math.sin(spreadAngle),
          dir[1] * Math.cos(spreadAngle) + rotatedNormal[1] * Math.sin(spreadAngle),
          dir[2] * Math.cos(spreadAngle) + rotatedNormal[2] * Math.sin(spreadAngle),
        ]

        const newLength = length * branchFactor * (0.85 + random() * 0.3)
        const newThickness = thickness * branchFactor

        addBranch(end, newDirection, newLength, newThickness, currentDepth - 1)
      }
    }
  }

  addBranch([0, -1.2, 0], [0, 1, 0], trunkHeight, 0.18, depth)

  return { name, color, vertices, triangles }
}

// ---------------------------------------------------------------------------
// Generator registry
// ---------------------------------------------------------------------------

export type ObjectGeneratorId =
  | 'cube'
  | 'sphere'
  | 'cylinder'
  | 'cone'
  | 'plane'
  | 'pyramid'
  | 'octahedron'
  | 'icosahedron'
  | 'dodecahedron'
  | 'torus'
  | 'torus-knot'
  | 'helix'
  | 'utah-teapot'
  | 'klein-bottle'
  | 'mobius-strip'
  | 'heart'
  | 'bowling-pin'
  | 'gear'
  | 'star'
  | 'menger-sponge'
  | 'sierpinski-tetrahedron'
  | 'fractal-terrain'
  | 'fractal-tree'

export interface ObjectGeneratorOption {
  id: ObjectGeneratorId
  label: string
  category: 'Primitives' | 'Complex' | 'Fractals' | 'Fun'
  generate: (color: string) => Mesh
}

export const OBJECT_GENERATORS: ObjectGeneratorOption[] = [
  {
    id: 'cube',
    label: 'Cube',
    category: 'Primitives',
    generate: (color) => ({ name: 'Cube', color, vertices: [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    ], triangles: [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6],
      [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
    ] }),
  },
  {
    id: 'sphere',
    label: 'Sphere',
    category: 'Primitives',
    generate: (color) => createSphereMesh('Sphere', color),
  },
  {
    id: 'cylinder',
    label: 'Cylinder',
    category: 'Primitives',
    generate: (color) => createCylinderMesh('Cylinder', color),
  },
  {
    id: 'cone',
    label: 'Cone',
    category: 'Primitives',
    generate: (color) => createConeMesh('Cone', color),
  },
  {
    id: 'plane',
    label: 'Plane',
    category: 'Primitives',
    generate: (color) => createPlaneMesh('Plane', color),
  },
  {
    id: 'pyramid',
    label: 'Pyramid',
    category: 'Primitives',
    generate: (color) => ({ name: 'Pyramid', color, vertices: [
      [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [0, 1.3, 0],
    ], triangles: [
      [0, 1, 2], [0, 2, 3], [0, 4, 1], [1, 4, 2], [2, 4, 3], [3, 4, 0],
    ] }),
  },
  {
    id: 'octahedron',
    label: 'Octahedron',
    category: 'Primitives',
    generate: (color) => ({ name: 'Octahedron', color, vertices: [
      [0, 1.3, 0], [1.1, 0, 0], [0, 0, 1.1], [-1.1, 0, 0], [0, 0, -1.1], [0, -1.3, 0],
    ], triangles: [
      [0, 2, 1], [0, 3, 2], [0, 4, 3], [0, 1, 4],
      [5, 1, 2], [5, 2, 3], [5, 3, 4], [5, 4, 1],
    ] }),
  },
  {
    id: 'icosahedron',
    label: 'Icosahedron',
    category: 'Primitives',
    generate: (color) => createIcosahedronMesh('Icosahedron', color),
  },
  {
    id: 'dodecahedron',
    label: 'Dodecahedron',
    category: 'Primitives',
    generate: (color) => createDodecahedronMesh('Dodecahedron', color),
  },
  {
    id: 'torus',
    label: 'Torus',
    category: 'Complex',
    generate: (color) => createTorusMesh('Torus', color),
  },
  {
    id: 'torus-knot',
    label: 'Torus Knot',
    category: 'Complex',
    generate: (color) => createTorusKnotMesh('Torus Knot', color),
  },
  {
    id: 'helix',
    label: 'Helix',
    category: 'Complex',
    generate: (color) => createHelixMesh('Helix', color),
  },
  {
    id: 'utah-teapot',
    label: 'Utah Teapot',
    category: 'Fun',
    generate: (color) => createUtahTeapotMesh('Utah Teapot', color),
  },
  {
    id: 'klein-bottle',
    label: 'Klein Bottle',
    category: 'Fun',
    generate: (color) => createKleinBottleMesh('Klein Bottle', color),
  },
  {
    id: 'mobius-strip',
    label: 'Mobius Strip',
    category: 'Fun',
    generate: (color) => createMobiusStripMesh('Mobius Strip', color),
  },
  {
    id: 'heart',
    label: 'Heart',
    category: 'Fun',
    generate: (color) => createHeartMesh('Heart', color),
  },
  {
    id: 'bowling-pin',
    label: 'Bowling Pin',
    category: 'Fun',
    generate: (color) => createBowlingPinMesh('Bowling Pin', color),
  },
  {
    id: 'gear',
    label: 'Gear',
    category: 'Fun',
    generate: (color) => createGearMesh('Gear', color),
  },
  {
    id: 'star',
    label: 'Star',
    category: 'Fun',
    generate: (color) => createStarMesh('Star', color),
  },
  {
    id: 'menger-sponge',
    label: 'Menger Sponge',
    category: 'Fractals',
    generate: (color) => {
      // Randomize complexity: 1-3 iterations (weighted toward 2)
      const roll = Math.random()
      const iterations = roll < 0.2 ? 1 : roll < 0.85 ? 2 : 3
      return createMengerSpongeMesh('Menger Sponge', color, iterations)
    },
  },
  {
    id: 'sierpinski-tetrahedron',
    label: 'Sierpinski Tetrahedron',
    category: 'Fractals',
    generate: (color) => {
      // Randomize complexity: 3-5 iterations
      const iterations = 3 + Math.floor(Math.random() * 3)
      return createSierpinskiTetrahedronMesh('Sierpinski Tetrahedron', color, iterations)
    },
  },
  {
    id: 'fractal-terrain',
    label: 'Fractal Terrain',
    category: 'Fractals',
    generate: (color) => createFractalTerrainMesh('Fractal Terrain', color, Math.floor(Math.random() * 100000)),
  },
  {
    id: 'fractal-tree',
    label: 'Fractal Tree',
    category: 'Fractals',
    generate: (color) => createFractalTreeMesh('Fractal Tree', color, Math.floor(Math.random() * 100000)),
  },
]