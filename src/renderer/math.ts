export type Vec3 = [number, number, number]
export type Mat4 = Float32Array

export function subVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}


export function dotVec3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

export function lengthVec3(value: Vec3): number {
  return Math.hypot(value[0], value[1], value[2])
}

export function normalizeVec3(value: Vec3): Vec3 {
  const length = lengthVec3(value)
  if (length === 0) {
    return [0, 0, 0]
  }

  return [value[0] / length, value[1] / length, value[2] / length]
}

export function createIdentityMat4(): Mat4 {
  const matrix = new Float32Array(16)
  matrix[0] = 1
  matrix[5] = 1
  matrix[10] = 1
  matrix[15] = 1
  return matrix
}

export function multiplyMat4(left: Mat4, right: Mat4): Mat4 {
  const output = new Float32Array(16)

  const left0 = left[0]
  const left1 = left[1]
  const left2 = left[2]
  const left3 = left[3]
  const left4 = left[4]
  const left5 = left[5]
  const left6 = left[6]
  const left7 = left[7]
  const left8 = left[8]
  const left9 = left[9]
  const left10 = left[10]
  const left11 = left[11]
  const left12 = left[12]
  const left13 = left[13]
  const left14 = left[14]
  const left15 = left[15]

  const right0 = right[0]
  const right1 = right[1]
  const right2 = right[2]
  const right3 = right[3]
  const right4 = right[4]
  const right5 = right[5]
  const right6 = right[6]
  const right7 = right[7]
  const right8 = right[8]
  const right9 = right[9]
  const right10 = right[10]
  const right11 = right[11]
  const right12 = right[12]
  const right13 = right[13]
  const right14 = right[14]
  const right15 = right[15]

  output[0] = left0 * right0 + left4 * right1 + left8 * right2 + left12 * right3
  output[1] = left1 * right0 + left5 * right1 + left9 * right2 + left13 * right3
  output[2] = left2 * right0 + left6 * right1 + left10 * right2 + left14 * right3
  output[3] = left3 * right0 + left7 * right1 + left11 * right2 + left15 * right3
  output[4] = left0 * right4 + left4 * right5 + left8 * right6 + left12 * right7
  output[5] = left1 * right4 + left5 * right5 + left9 * right6 + left13 * right7
  output[6] = left2 * right4 + left6 * right5 + left10 * right6 + left14 * right7
  output[7] = left3 * right4 + left7 * right5 + left11 * right6 + left15 * right7
  output[8] = left0 * right8 + left4 * right9 + left8 * right10 + left12 * right11
  output[9] = left1 * right8 + left5 * right9 + left9 * right10 + left13 * right11
  output[10] = left2 * right8 + left6 * right9 + left10 * right10 + left14 * right11
  output[11] = left3 * right8 + left7 * right9 + left11 * right10 + left15 * right11
  output[12] = left0 * right12 + left4 * right13 + left8 * right14 + left12 * right15
  output[13] = left1 * right12 + left5 * right13 + left9 * right14 + left13 * right15
  output[14] = left2 * right12 + left6 * right13 + left10 * right14 + left14 * right15
  output[15] = left3 * right12 + left7 * right13 + left11 * right14 + left15 * right15

  return output
}

export function createTranslationMat4(x: number, y: number, z: number): Mat4 {
  const matrix = createIdentityMat4()
  matrix[12] = x
  matrix[13] = y
  matrix[14] = z
  return matrix
}

export function createScaleMat4(x: number, y: number, z: number): Mat4 {
  const matrix = createIdentityMat4()
  matrix[0] = x
  matrix[5] = y
  matrix[10] = z
  return matrix
}

export function createRotationXMat4(angle: number): Mat4 {
  const sine = Math.sin(angle)
  const cosine = Math.cos(angle)
  const matrix = createIdentityMat4()
  matrix[5] = cosine
  matrix[6] = sine
  matrix[9] = -sine
  matrix[10] = cosine
  return matrix
}

export function createRotationYMat4(angle: number): Mat4 {
  const sine = Math.sin(angle)
  const cosine = Math.cos(angle)
  const matrix = createIdentityMat4()
  matrix[0] = cosine
  matrix[2] = -sine
  matrix[8] = sine
  matrix[10] = cosine
  return matrix
}

export function createRotationZMat4(angle: number): Mat4 {
  const sine = Math.sin(angle)
  const cosine = Math.cos(angle)
  const matrix = createIdentityMat4()
  matrix[0] = cosine
  matrix[1] = sine
  matrix[4] = -sine
  matrix[5] = cosine
  return matrix
}

export function composeTransformMat4(
  position: Vec3,
  rotation: Vec3,
  scale: Vec3,
): Mat4 {
  const scaled = createScaleMat4(scale[0], scale[1], scale[2])
  const rotatedX = multiplyMat4(createRotationXMat4(rotation[0]), scaled)
  const rotatedY = multiplyMat4(createRotationYMat4(rotation[1]), rotatedX)
  const rotatedZ = multiplyMat4(createRotationZMat4(rotation[2]), rotatedY)
  return multiplyMat4(createTranslationMat4(position[0], position[1], position[2]), rotatedZ)
}

export function transformPoint(mat: Mat4, point: Vec3): Vec3 {
  const x = point[0]
  const y = point[1]
  const z = point[2]

  return [
    mat[0] * x + mat[4] * y + mat[8] * z + mat[12],
    mat[1] * x + mat[5] * y + mat[9] * z + mat[13],
    mat[2] * x + mat[6] * y + mat[10] * z + mat[14],
  ]
}

export function createLookAtMat4(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const forward = normalizeVec3(subVec3(target, eye))
  const side = normalizeVec3(crossVec3(forward, up))
  const cameraUp = crossVec3(side, forward)

  const matrix = createIdentityMat4()
  matrix[0] = side[0]
  matrix[1] = side[1]
  matrix[2] = side[2]
  matrix[4] = cameraUp[0]
  matrix[5] = cameraUp[1]
  matrix[6] = cameraUp[2]
  matrix[8] = -forward[0]
  matrix[9] = -forward[1]
  matrix[10] = -forward[2]
  matrix[12] = -dotVec3(side, eye)
  matrix[13] = -dotVec3(cameraUp, eye)
  matrix[14] = dotVec3(forward, eye)

  return matrix
}
