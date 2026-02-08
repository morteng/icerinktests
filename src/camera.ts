/**
 * 3D orbit camera for isometric/3D view
 */

export type CameraPreset = 'corner' | 'top' | 'front' | 'side' | 'tv' | 'oblique';

export interface CameraState {
  distance: number;
  azimuth: number;
  elevation: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  ortho: boolean;
  locked: boolean;
}

/** Invert a 4x4 column-major matrix using cofactor expansion.
 *  Based on the standard Mesa/GLU implementation.
 *  Returns identity if the matrix is singular. */
function mat4Inverse(m: Float32Array): Float32Array {
  const inv = new Float32Array(16);

  inv[0] = m[5]  * m[10] * m[15] -
            m[5]  * m[11] * m[14] -
            m[9]  * m[6]  * m[15] +
            m[9]  * m[7]  * m[14] +
            m[13] * m[6]  * m[11] -
            m[13] * m[7]  * m[10];

  inv[4] = -m[4]  * m[10] * m[15] +
             m[4]  * m[11] * m[14] +
             m[8]  * m[6]  * m[15] -
             m[8]  * m[7]  * m[14] -
             m[12] * m[6]  * m[11] +
             m[12] * m[7]  * m[10];

  inv[8] = m[4]  * m[9]  * m[15] -
            m[4]  * m[11] * m[13] -
            m[8]  * m[5]  * m[15] +
            m[8]  * m[7]  * m[13] +
            m[12] * m[5]  * m[11] -
            m[12] * m[7]  * m[9];

  inv[12] = -m[4]  * m[9]  * m[14] +
              m[4]  * m[10] * m[13] +
              m[8]  * m[5]  * m[14] -
              m[8]  * m[6]  * m[13] -
              m[12] * m[5]  * m[10] +
              m[12] * m[6]  * m[9];

  inv[1] = -m[1]  * m[10] * m[15] +
             m[1]  * m[11] * m[14] +
             m[9]  * m[2]  * m[15] -
             m[9]  * m[3]  * m[14] -
             m[13] * m[2]  * m[11] +
             m[13] * m[3]  * m[10];

  inv[5] = m[0]  * m[10] * m[15] -
            m[0]  * m[11] * m[14] -
            m[8]  * m[2]  * m[15] +
            m[8]  * m[3]  * m[14] +
            m[12] * m[2]  * m[11] -
            m[12] * m[3]  * m[10];

  inv[9] = -m[0]  * m[9]  * m[15] +
             m[0]  * m[11] * m[13] +
             m[8]  * m[1]  * m[15] -
             m[8]  * m[3]  * m[13] -
             m[12] * m[1]  * m[11] +
             m[12] * m[3]  * m[9];

  inv[13] = m[0]  * m[9]  * m[14] -
             m[0]  * m[10] * m[13] -
             m[8]  * m[1]  * m[14] +
             m[8]  * m[2]  * m[13] +
             m[12] * m[1]  * m[10] -
             m[12] * m[2]  * m[9];

  inv[2] = m[1]  * m[6]  * m[15] -
            m[1]  * m[7]  * m[14] -
            m[5]  * m[2]  * m[15] +
            m[5]  * m[3]  * m[14] +
            m[13] * m[2]  * m[7] -
            m[13] * m[3]  * m[6];

  inv[6] = -m[0]  * m[6]  * m[15] +
             m[0]  * m[7]  * m[14] +
             m[4]  * m[2]  * m[15] -
             m[4]  * m[3]  * m[14] -
             m[12] * m[2]  * m[7] +
             m[12] * m[3]  * m[6];

  inv[10] = m[0]  * m[5]  * m[15] -
             m[0]  * m[7]  * m[13] -
             m[4]  * m[1]  * m[15] +
             m[4]  * m[3]  * m[13] +
             m[12] * m[1]  * m[7] -
             m[12] * m[3]  * m[5];

  inv[14] = -m[0]  * m[5]  * m[14] +
              m[0]  * m[6]  * m[13] +
              m[4]  * m[1]  * m[14] -
              m[4]  * m[2]  * m[13] -
              m[12] * m[1]  * m[6] +
              m[12] * m[2]  * m[5];

  inv[3] = -m[1]  * m[6]  * m[11] +
             m[1]  * m[7]  * m[10] +
             m[5]  * m[2]  * m[11] -
             m[5]  * m[3]  * m[10] -
             m[9]  * m[2]  * m[7] +
             m[9]  * m[3]  * m[6];

  inv[7] = m[0]  * m[6]  * m[11] -
            m[0]  * m[7]  * m[10] -
            m[4]  * m[2]  * m[11] +
            m[4]  * m[3]  * m[10] +
            m[8]  * m[2]  * m[7] -
            m[8]  * m[3]  * m[6];

  inv[11] = -m[0]  * m[5]  * m[11] +
              m[0]  * m[7]  * m[9] +
              m[4]  * m[1]  * m[11] -
              m[4]  * m[3]  * m[9] -
              m[8]  * m[1]  * m[7] +
              m[8]  * m[3]  * m[5];

  inv[15] = m[0]  * m[5]  * m[10] -
             m[0]  * m[6]  * m[9] -
             m[4]  * m[1]  * m[10] +
             m[4]  * m[2]  * m[9] +
             m[8]  * m[1]  * m[6] -
             m[8]  * m[2]  * m[5];

  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];

  if (Math.abs(det) < 1e-10) {
    inv.fill(0);
    inv[0] = inv[5] = inv[10] = inv[15] = 1;
    return inv;
  }

  const invDet = 1.0 / det;
  for (let i = 0; i < 16; i++) inv[i] *= invDet;

  return inv;
}

export class Camera {
  // Spherical coordinates
  private distance: number = 400;
  private azimuth: number = 0; // rotation around Y axis (radians)
  private elevation: number = Math.PI / 3; // angle from ground (radians)

  // Target point to orbit around
  private targetX: number = 0;
  private targetY: number = 0;
  private targetZ: number = 0;

  // Computed camera position
  private posX: number = 0;
  private posY: number = 0;
  private posZ: number = 0;

  // View and projection matrices (column-major for WebGPU)
  private viewMatrix: Float32Array = new Float32Array(16);
  private projMatrix: Float32Array = new Float32Array(16);

  // Grid dimensions (for presets)
  private gridW: number;
  private gridH: number;

  // Projection mode
  ortho = true;

  // Lock mode (no orbit, only pan+zoom)
  locked = false;

  // TV camera active (disables mouse controls)
  tvActive = false;

  constructor(gridW: number, gridH: number) {
    this.gridW = gridW;
    this.gridH = gridH;

    // Center camera on grid
    this.targetX = gridW / 2;
    this.targetY = 0;
    this.targetZ = gridH / 2;

    // Initial view: near top-down with slight angle to see sky
    this.azimuth = 0;
    this.elevation = Math.PI * 0.42; // ~76 degrees (near top-down)
    this.distance = Math.max(gridW, gridH) * 1.5;

    this.updatePosition();
    this.updateMatrices(800, 600); // default aspect
  }

  private updatePosition() {
    // Convert spherical to cartesian
    const cosElev = Math.cos(this.elevation);
    const sinElev = Math.sin(this.elevation);
    const cosAzim = Math.cos(this.azimuth);
    const sinAzim = Math.sin(this.azimuth);

    this.posX = this.targetX + this.distance * cosElev * sinAzim;
    this.posY = this.targetY + this.distance * sinElev;
    this.posZ = this.targetZ + this.distance * cosElev * cosAzim;
  }

  private updateMatrices(width: number, height: number) {
    // View matrix (lookAt)
    const eye = [this.posX, this.posY, this.posZ];
    const target = [this.targetX, this.targetY, this.targetZ];
    const up = [0, 1, 0];

    // Forward = normalize(target - eye)
    const fx = target[0] - eye[0];
    const fy = target[1] - eye[1];
    const fz = target[2] - eye[2];
    const flen = Math.sqrt(fx*fx + fy*fy + fz*fz);
    const f = [fx/flen, fy/flen, fz/flen];

    // Right = normalize(cross(forward, up))
    const rx = f[1]*up[2] - f[2]*up[1];
    const ry = f[2]*up[0] - f[0]*up[2];
    const rz = f[0]*up[1] - f[1]*up[0];
    const rlen = Math.sqrt(rx*rx + ry*ry + rz*rz);
    const r = [rx/rlen, ry/rlen, rz/rlen];

    // Up = cross(right, forward)
    const ux = r[1]*f[2] - r[2]*f[1];
    const uy = r[2]*f[0] - r[0]*f[2];
    const uz = r[0]*f[1] - r[1]*f[0];

    // View matrix (column-major)
    this.viewMatrix[0] = r[0];
    this.viewMatrix[1] = ux;
    this.viewMatrix[2] = -f[0];
    this.viewMatrix[3] = 0;

    this.viewMatrix[4] = r[1];
    this.viewMatrix[5] = uy;
    this.viewMatrix[6] = -f[1];
    this.viewMatrix[7] = 0;

    this.viewMatrix[8] = r[2];
    this.viewMatrix[9] = uz;
    this.viewMatrix[10] = -f[2];
    this.viewMatrix[11] = 0;

    this.viewMatrix[12] = -(r[0]*eye[0] + r[1]*eye[1] + r[2]*eye[2]);
    this.viewMatrix[13] = -(ux*eye[0] + uy*eye[1] + uz*eye[2]);
    this.viewMatrix[14] = f[0]*eye[0] + f[1]*eye[1] + f[2]*eye[2];
    this.viewMatrix[15] = 1;

    const aspect = width / height;
    const near = 1.0;
    const far = 5000.0;

    this.projMatrix.fill(0);

    if (this.ortho) {
      // Orthographic: size scales with distance so zoom works naturally
      const halfH = this.distance * 0.5;
      const halfW = halfH * aspect;
      const rangeInv = 1.0 / (near - far);

      this.projMatrix[0] = 1.0 / halfW;
      this.projMatrix[5] = 1.0 / halfH;
      this.projMatrix[10] = rangeInv;       // -1/(far-near)
      this.projMatrix[14] = near * rangeInv; // -near/(far-near)
      this.projMatrix[15] = 1;
    } else {
      // Perspective
      const fov = Math.PI / 4; // 45 degrees
      const f_proj = 1.0 / Math.tan(fov / 2);
      const rangeInv = 1.0 / (near - far);

      this.projMatrix[0] = f_proj / aspect;
      this.projMatrix[5] = f_proj;
      this.projMatrix[10] = far * rangeInv;
      this.projMatrix[11] = -1;
      this.projMatrix[14] = near * far * rangeInv;
    }
  }

  // Direct setters (used by SpriteStudio for programmatic control)
  setAzimuth(a: number) { this.azimuth = a; this.updatePosition(); }
  setElevation(e: number) { this.elevation = Math.max(0.1, Math.min(Math.PI / 2 - 0.01, e)); this.updatePosition(); }
  setDistance(d: number) { this.distance = Math.max(50, Math.min(2000, d)); this.updatePosition(); }

  // Mouse controls
  orbit(deltaAzimuth: number, deltaElevation: number) {
    if (this.locked) return;
    this.azimuth += deltaAzimuth;
    this.elevation = Math.max(0.1, Math.min(Math.PI / 2 - 0.01, this.elevation + deltaElevation));
    this.updatePosition();
  }

  zoom(delta: number) {
    this.distance = Math.max(50, Math.min(2000, this.distance * (1 + delta)));
    this.updatePosition();
  }

  pan(dx: number, dz: number) {
    // Pan in camera space
    const cosAzim = Math.cos(this.azimuth);
    const sinAzim = Math.sin(this.azimuth);

    this.targetX += dx * cosAzim - dz * sinAzim;
    this.targetZ += dx * sinAzim + dz * cosAzim;
    this.updatePosition();
  }

  reset(gridW: number, gridH: number) {
    this.gridW = gridW;
    this.gridH = gridH;
    this.targetX = gridW / 2;
    this.targetY = 0;
    this.targetZ = gridH / 2;
    this.azimuth = 0;
    this.elevation = Math.PI / 3;
    this.distance = Math.max(gridW, gridH) * 1.5;
    this.updatePosition();
  }

  /** Set camera to a named preset angle */
  setPreset(preset: CameraPreset) {
    this.targetX = this.gridW / 2;
    this.targetY = 0;
    this.targetZ = this.gridH / 2;

    switch (preset) {
      case 'top':
        this.azimuth = 0;
        this.elevation = Math.PI / 2 - 0.01; // nearly straight down
        this.distance = Math.max(this.gridW, this.gridH) * 1.2;
        this.locked = false;
        break;
      case 'front':
        this.azimuth = 0;
        this.elevation = Math.PI / 12; // 15 degrees — low angle from long side
        this.distance = Math.max(this.gridW, this.gridH) * 1.5;
        this.locked = false;
        break;
      case 'side':
        this.azimuth = Math.PI / 2; // from the short side
        this.elevation = Math.PI / 6; // 30 degrees
        this.distance = Math.max(this.gridW, this.gridH) * 1.5;
        this.locked = false;
        break;
      case 'tv':
        this.azimuth = 0;
        this.elevation = Math.PI / 6; // 30 degrees — classic broadcast angle
        this.distance = Math.max(this.gridW, this.gridH) * 1.8;
        this.locked = false;
        break;
      case 'oblique':
        this.azimuth = 0;
        this.elevation = Math.PI * 0.31; // ~56 degrees — classic 3/4 sim view
        this.distance = Math.max(this.gridW, this.gridH) * 1.2;
        this.ortho = true;
        this.locked = true;
        break;
      case 'corner':
      default:
        this.azimuth = Math.PI / 4; // 45 degrees
        this.elevation = Math.PI / 4; // 45 degrees
        this.distance = Math.max(this.gridW, this.gridH) * 1.5;
        this.locked = false;
        break;
    }
    this.updatePosition();
  }

  private lastAspect = 1;

  update(width: number, height: number) {
    this.lastAspect = width / height;
    this.updateMatrices(width, height);
  }

  /** Cast a ray from camera through NDC coordinates (-1..1) and intersect y=0 plane. */
  screenToGrid(ndcX: number, ndcY: number): [number, number] | null {
    // Extract camera basis from view matrix (column-major)
    const right = [this.viewMatrix[0], this.viewMatrix[4], this.viewMatrix[8]];
    const up = [this.viewMatrix[1], this.viewMatrix[5], this.viewMatrix[9]];
    const fwd = [-this.viewMatrix[2], -this.viewMatrix[6], -this.viewMatrix[10]];

    if (this.ortho) {
      // Orthographic: ray origin offset, direction is constant (forward)
      const halfH = this.distance * 0.5;
      const halfW = halfH * this.lastAspect;
      const ox = this.posX + right[0] * ndcX * halfW + up[0] * ndcY * halfH;
      const oy = this.posY + right[1] * ndcX * halfW + up[1] * ndcY * halfH;
      const oz = this.posZ + right[2] * ndcX * halfW + up[2] * ndcY * halfH;

      if (fwd[1] >= 0) return null;
      const t = -oy / fwd[1];
      if (t < 0) return null;
      return [ox + t * fwd[0], oz + t * fwd[2]];
    }

    const fov = Math.PI / 4;
    const tanFov = Math.tan(fov / 2);

    // Ray direction in world space
    const dx = ndcX * this.lastAspect * tanFov;
    const dy = ndcY * tanFov;

    let dirX = fwd[0] + right[0] * dx + up[0] * dy;
    let dirY = fwd[1] + right[1] * dx + up[1] * dy;
    let dirZ = fwd[2] + right[2] * dx + up[2] * dy;
    const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
    dirX /= len; dirY /= len; dirZ /= len;

    // Intersect with y=0 plane
    if (dirY >= 0) return null; // looking up
    const t = -this.posY / dirY;
    if (t < 0) return null;
    return [this.posX + t * dirX, this.posZ + t * dirZ];
  }

  /** Set the orbit target position. */
  setTarget(x: number, y: number, z: number) {
    this.targetX = x;
    this.targetY = y;
    this.targetZ = z;
    this.updatePosition();
  }

  /** Get full camera state (for save/restore). */
  getFullState(): CameraState {
    return {
      distance: this.distance,
      azimuth: this.azimuth,
      elevation: this.elevation,
      targetX: this.targetX,
      targetY: this.targetY,
      targetZ: this.targetZ,
      ortho: this.ortho,
      locked: this.locked,
    };
  }

  /** Restore camera state from a snapshot. */
  setState(state: CameraState) {
    this.distance = state.distance;
    this.azimuth = state.azimuth;
    this.elevation = state.elevation;
    this.targetX = state.targetX;
    this.targetY = state.targetY;
    this.targetZ = state.targetZ;
    this.ortho = state.ortho;
    this.locked = state.locked;
    this.updatePosition();
  }

  /** Get camera state for debug API. */
  getState(): {
    distance: number; azimuth: number; elevation: number;
    targetX: number; targetY: number; targetZ: number;
    posX: number; posY: number; posZ: number;
    ortho: boolean; locked: boolean;
  } {
    return {
      distance: this.distance,
      azimuth: this.azimuth,
      elevation: this.elevation,
      targetX: this.targetX,
      targetY: this.targetY,
      targetZ: this.targetZ,
      posX: this.posX,
      posY: this.posY,
      posZ: this.posZ,
      ortho: this.ortho,
      locked: this.locked,
    };
  }

  getViewMatrix(): Float32Array {
    return this.viewMatrix;
  }

  getProjectionMatrix(): Float32Array {
    return this.projMatrix;
  }

  /** Compute inverse(proj * view) for screen-to-world ray reconstruction.
   *  Uses the standard cofactor/adjugate method for 4x4 matrices.
   *  Column-major layout: element(row, col) = array[col*4 + row].
   */
  getInverseViewProjection(): Float32Array {
    // Multiply VP = proj * view (column-major)
    const vp = new Float32Array(16);
    const v = this.viewMatrix;
    const p = this.projMatrix;
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        vp[c * 4 + r] =
          p[0 * 4 + r] * v[c * 4 + 0] +
          p[1 * 4 + r] * v[c * 4 + 1] +
          p[2 * 4 + r] * v[c * 4 + 2] +
          p[3 * 4 + r] * v[c * 4 + 3];
      }
    }

    return mat4Inverse(vp);
  }

  getPosition(): [number, number, number] {
    return [this.posX, this.posY, this.posZ];
  }

  /** View-space right vector (column 0 of view matrix) for billboard construction. */
  getBillboardRight(): [number, number, number] {
    return [this.viewMatrix[0], this.viewMatrix[4], this.viewMatrix[8]];
  }

  getForward(): [number, number, number] {
    const fx = this.targetX - this.posX;
    const fy = this.targetY - this.posY;
    const fz = this.targetZ - this.posZ;
    const len = Math.sqrt(fx*fx + fy*fy + fz*fz);
    return [fx/len, fy/len, fz/len];
  }
}
