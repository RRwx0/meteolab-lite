(function (global) {
  'use strict';
  var ML = global.ML || (global.ML = {});

  function mat4Identity() {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }

  function perspective(out, fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = (far + near) / (near - far); out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = 2 * far * near / (near - far); out[15] = 0;
    return out;
  }

  function lookAt(out, eye, center, up) {
    var zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    var len = Math.hypot(zx, zy, zz);
    zx /= len; zy /= len; zz /= len;
    var xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz);
    xx /= len; xy /= len; xz /= len;
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  }

  function mul(out, a, b) {
    for (var i = 0; i < 4; i++) {
      for (var j = 0; j < 4; j++) {
        var s = 0;
        for (var k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
        out[i * 4 + j] = s;
      }
    }
    return out;
  }

  function invert(out, m) {
    var a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    var a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    var a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    var a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    var b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10,
      b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11,
      b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12,
      b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30,
      b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31,
      b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return out;
    det = 1 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  }

  var VS = [
    '#version 300 es',
    'in vec2 aPos; out vec2 vUv;',
    'void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');

  var FS_SKY = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv; out vec4 fragColor;',
    'uniform mat4 uInvVP; uniform vec3 uEye; uniform vec3 uSun;',
    'void main(){',
    '  vec4 pw = uInvVP * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);',
    '  vec3 wp = pw.xyz / pw.w;',
    '  vec3 rd = normalize(wp - uEye);',
    '  float h = clamp(rd.y * 1.5 + 0.06, 0.0, 1.0);',
    '  vec3 low = vec3(0.12, 0.15, 0.19);',
    '  vec3 high = vec3(0.02, 0.03, 0.06);',
    '  vec3 col = mix(low, high, pow(h, 0.65));',
    '  col += vec3(0.10, 0.08, 0.05) * pow(max(0.0, dot(rd, uSun)), 18.0);',
    '  fragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var VS_GROUND = [
    '#version 300 es',
    'in vec3 aPos; in vec2 aUv;',
    'uniform mat4 uVP;',
    'out vec2 vUv; out vec3 vWorld;',
    'void main(){ vUv = aUv; vWorld = aPos; gl_Position = uVP * vec4(aPos, 1.0); }'
  ].join('\n');

  var FS_GROUND = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv; in vec3 vWorld;',
    'out vec4 fragColor;',
    'uniform sampler2D uGround;',
    'uniform float uGroundGain;',
    'void main(){',
    '  vec4 g = texture(uGround, vUv);',
    '  vec3 base = vec3(0.055, 0.075, 0.085);',
    '  vec2 gd = abs(fract(vWorld.xz / 5.0) - 0.5);',
    '  float line = smoothstep(0.47, 0.5, max(gd.x, gd.y));',
    '  base += vec3(0.035, 0.05, 0.055) * line;',
    '  float rain = clamp(g.r * uGroundGain, 0.0, 1.0);',
    '  float cold = clamp(g.g, 0.0, 1.0);',
    '  base = mix(base, vec3(0.10, 0.32, 0.38), cold * 0.55);',
    '  base = mix(base, vec3(0.10, 0.42, 0.55), rain * 0.75);',
    '  fragColor = vec4(base, 1.0);',
    '}'
  ].join('\n');

  var FS_VOL = [
    '#version 300 es',
    'precision highp float;',
    'precision highp sampler3D;',
    'in vec2 vUv; out vec4 fragColor;',
    'uniform sampler3D uVol;',
    'uniform mat4 uInvVP;',
    'uniform vec3 uEye; uniform vec3 uBoxMin; uniform vec3 uBoxMax; uniform vec3 uSun;',
    'uniform float uOpacity; uniform int uChannel; uniform float uSteps; uniform float uClip;',
    'vec2 boxHit(vec3 ro, vec3 rd){',
    '  vec3 inv = 1.0 / rd;',
    '  vec3 t0 = (uBoxMin - ro) * inv;',
    '  vec3 t1 = (uBoxMax - ro) * inv;',
    '  vec3 tmin = min(t0, t1);',
    '  vec3 tmax = max(t0, t1);',
    '  float tn = max(max(tmin.x, tmin.y), tmin.z);',
    '  float tf = min(min(tmax.x, tmax.y), tmax.z);',
    '  return vec2(tn, tf);',
    '}',
    'float dens(vec3 uvw){',
    '  vec4 s = texture(uVol, uvw);',
    '  float d = (uChannel == 0) ? s.r : (uChannel == 1 ? s.g : s.b);',
    '  return pow(clamp(d, 0.0, 1.0), 0.75);',
    '}',
    'void main(){',
    '  vec4 pw = uInvVP * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);',
    '  vec3 wp = pw.xyz / pw.w;',
    '  vec3 ro = uEye;',
    '  vec3 rd = normalize(wp - ro);',
    '  vec2 hit = boxHit(ro, rd);',
    '  if (hit.y <= max(hit.x, 0.0)) { discard; }',
    '  float t0 = max(hit.x, 0.0);',
    '  float t1 = hit.y;',
    '  if (uClip > 0.02) {',
    '    if (abs(rd.y) > 0.0001) {',
    '      float tc = (uClip - uEye.y) / rd.y;',
    '      if (tc > t0) t0 = tc;',
    '    } else if (uEye.y < uClip) {',
    '      discard;',
    '    }',
    '    if (uEye.y < uClip && rd.y < 0.0001) discard;',
    '  }',
    '  if (t0 >= t1) discard;',
    '  int steps = int(uSteps);',
    '  float ds = (t1 - t0) / float(steps);',
    '  vec3 p = ro + rd * t0;',
    '  vec3 acc = vec3(0.0);',
    '  float trans = 1.0;',
    '  vec3 sunDir = normalize(uSun);',
    '  for (int i = 0; i < 160; i++) {',
    '    if (i >= steps || trans < 0.02) break;',
    '    vec3 uvw = (p - uBoxMin) / (uBoxMax - uBoxMin);',
    '    float d = dens(uvw);',
    '    if (d > 0.004) {',
    '      float occ = 0.0;',
    '      occ += dens(uvw + sunDir * 0.035);',
    '      occ += dens(uvw + sunDir * 0.085);',
    '      occ += dens(uvw + sunDir * 0.16);',
    '      float light = exp(-occ * 4.2);',
    '      vec3 lit = mix(vec3(0.16, 0.20, 0.28), vec3(0.92, 0.95, 1.0), light);',
    '      lit += vec3(0.25, 0.20, 0.12) * pow(max(0.0, dot(rd, sunDir)), 6.0) * light;',
    '      if (uChannel == 1) lit = mix(vec3(0.10, 0.22, 0.34), vec3(0.42, 0.72, 0.95), light);',
    '      float a = 1.0 - exp(-d * uOpacity * ds);',
    '      acc += trans * a * lit;',
    '      trans *= (1.0 - a);',
    '    }',
    '    p += rd * ds;',
    '  }',
    '  acc += trans * vec3(0.0);',
    '  float alpha = 1.0 - trans;',
    '  if (alpha < 0.003) discard;',
    '  fragColor = vec4(acc, alpha);',
    '}'
  ].join('\n');

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader: ' + log);
    }
    return sh;
  }

  function program(gl, vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function VolumeView(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.yaw = 0.7;
    this.pitch = 0.42;
    this.dist = 96;
    this.target = [20, 3.6, 20];
    this.showRain = false;
    this.channel = 0;
    this.clip = 0;
    this.autoRotate = false;
    this.quality = 96;
    this._vp = mat4Identity();
    this._inv = mat4Identity();
    this._view = mat4Identity();
    this._proj = mat4Identity();
    this._needUpload = true;
    try {
      this._init();
      this.ok = true;
    } catch (e) {
      this.error = e.message;
      this.ok = false;
    }
  }

  VolumeView.prototype._init = function () {
    var canvas = this.canvas;
    var gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL 2 недоступен');
    this.gl = gl;
    this.progSky = program(gl, VS, FS_SKY);
    this.progGround = program(gl, VS_GROUND, FS_GROUND);
    this.progVol = program(gl, VS, FS_VOL);

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.groundBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.groundBuf);
    this.groundData = new Float32Array(5 * 4);
    gl.bufferData(gl.ARRAY_BUFFER, this.groundData, gl.DYNAMIC_DRAW);

    this.texVol = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.texVol);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

    this.texGround = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texGround);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.groundIdx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.groundIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  };

  VolumeView.prototype.setModel = function (model) {
    this.model = model;
    var nx = model.nx, ny = model.ny, nz = model.nz;
    if (!this.volData || this.volData.length !== nx * ny * nz * 4) {
      this.volData = new Uint8Array(nx * ny * nz * 4);
      this.gndData = new Uint8Array(nx * ny * 4);
    }
    this._needUpload = true;
  };

  VolumeView.prototype._upload = function () {
    var gl = this.gl, m = this.model;
    if (!m) return;
    var nx = m.nx, ny = m.ny, nz = m.nz;
    var vol = this.volData, gnd = this.gndData;
    var nxny = nx * ny;
    var cloudScale = 420, rainScale = 900;
    var p = 0;
    for (var j = 0; j < ny; j++) {
      for (var k = 0; k < nz; k++) {
        for (var i = 0; i < nx; i++, p += 4) {
          var c = i + nx * (j + ny * k);
          var cl = (m.qc[c] + m.qi[c]) * cloudScale;
          var rn = m.qr[c] * rainScale;
          var ic = m.qi[c] * cloudScale * 0.9;
          vol[p] = Math.min(255, 255 * Math.min(1, Math.sqrt(Math.max(0, cl))));
          vol[p + 1] = Math.min(255, 255 * Math.min(1, Math.sqrt(Math.max(0, rn))));
          vol[p + 2] = Math.min(255, 255 * Math.min(1, Math.sqrt(Math.max(0, ic))));
          vol[p + 3] = 255;
        }
      }
    }
    gl.bindTexture(gl.TEXTURE_3D, this.texVol);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, nx, nz, ny, 0, gl.RGBA, gl.UNSIGNED_BYTE, vol);

    var q = 0;
    for (var jj = 0; jj < ny; jj++) {
      for (var ii = 0; ii < nx; ii++, q += 4) {
        var col = jj * nx + ii;
        var rain = Math.min(1, m.acc[col] / 40);
        var cold = Math.min(1, Math.max(0, -(m.th[col] - m.th0[0])) / 8);
        gnd[q] = 255 * Math.pow(rain, 0.6);
        gnd[q + 1] = 255 * cold;
        gnd[q + 2] = 255 * Math.min(1, m.colMaxZ[col] / 12000);
        gnd[q + 3] = 255;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texGround);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, nx, ny, 0, gl.RGBA, gl.UNSIGNED_BYTE, gnd);
    this._needUpload = false;
  };

  VolumeView.prototype.resize = function () {
    var canvas = this.canvas;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    var h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };

  VolumeView.prototype.render = function () {
    if (!this.ok || !this.model) return;
    var gl = this.gl;
    this.resize();
    var m = this.model;
    if (this.autoRotate) this.yaw += 0.0022;
    var xmax = m.xmax / 1000, zmax = m.zmax / 1000, ymax = m.ymax / 1000;
    var W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);

    var cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    var eye = [
      this.target[0] + this.dist * cp * Math.sin(this.yaw),
      this.target[1] + this.dist * sp,
      this.target[2] + this.dist * cp * Math.cos(this.yaw)
    ];
    perspective(this._proj, 0.75, W / H, 0.5, 900);
    lookAt(this._view, eye, this.target, [0, 1, 0]);
    mul(this._vp, this._proj, this._view);
    invert(this._inv, this._vp);

    if (this._needUpload) this._upload();

    gl.clearColor(0.02, 0.03, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.progSky);
    var loc = gl.getUniformLocation(this.progSky, 'uInvVP');
    gl.uniformMatrix4fv(loc, false, this._inv);
    gl.uniform3fv(gl.getUniformLocation(this.progSky, 'uEye'), eye);
    gl.uniform3fv(gl.getUniformLocation(this.progSky, 'uSun'), [0.55, 0.62, 0.42]);
    this._quadDraw(this.progSky);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    var gd = this.groundData;
    var gx0 = 0, gz0 = 0, gx1 = xmax, gz1 = ymax;
    gd.set([
      gx0, 0, gz0, 0, 1,
      gx1, 0, gz0, 1, 1,
      gx1, 0, gz1, 1, 0,
      gx0, 0, gz1, 0, 0
    ]);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.progGround);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.groundBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, gd);
    var la = gl.getAttribLocation(this.progGround, 'aPos');
    var lu = gl.getAttribLocation(this.progGround, 'aUv');
    gl.enableVertexAttribArray(la);
    gl.vertexAttribPointer(la, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(lu);
    gl.vertexAttribPointer(lu, 2, gl.FLOAT, false, 20, 12);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progGround, 'uVP'), false, this._vp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texGround);
    gl.uniform1i(gl.getUniformLocation(this.progGround, 'uGround'), 0);
    gl.uniform1f(gl.getUniformLocation(this.progGround, 'uGroundGain'), 1.6);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.groundIdx);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disableVertexAttribArray(la);
    gl.disableVertexAttribArray(lu);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.progVol);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progVol, 'uInvVP'), false, this._inv);
    gl.uniform3fv(gl.getUniformLocation(this.progVol, 'uEye'), eye);
    gl.uniform3fv(gl.getUniformLocation(this.progVol, 'uBoxMin'), [0, 0, 0]);
    gl.uniform3fv(gl.getUniformLocation(this.progVol, 'uBoxMax'), [xmax, zmax, ymax]);
    gl.uniform3fv(gl.getUniformLocation(this.progVol, 'uSun'), [0.55, 0.62, 0.42]);
    var opacity = this.channel === 1 ? 9 : (this.channel === 2 ? 11 : 15);
    gl.uniform1f(gl.getUniformLocation(this.progVol, 'uOpacity'), opacity);
    gl.uniform1i(gl.getUniformLocation(this.progVol, 'uChannel'), this.channel);
    gl.uniform1f(gl.getUniformLocation(this.progVol, 'uSteps'), this.quality);
    gl.uniform1f(gl.getUniformLocation(this.progVol, 'uClip'), this.clip);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.texVol);
    gl.uniform1i(gl.getUniformLocation(this.progVol, 'uVol'), 0);
    this._quadDraw(this.progVol);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
  };

  VolumeView.prototype._quadDraw = function (prog) {
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    var a = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  };

  VolumeView.prototype.orbit = function (dx, dy) {
    this.yaw -= dx * 0.006;
    this.pitch = Math.max(0.04, Math.min(1.45, this.pitch + dy * 0.005));
  };

  VolumeView.prototype.capture = function () {
    if (!this.ok) return null;
    this.render();
    try { return this.canvas.toDataURL('image/png'); } catch (e) { return null; }
  };

  VolumeView.prototype.project = function (x, y, z) {
    if (!this.ok) return null;
    var vp = this._vp;
    var cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    var cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    var cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw <= 0.0001) return null;
    var nx = cx / cw, ny = cy / cw;
    if (nx < -1.4 || nx > 1.4 || ny < -1.4 || ny > 1.4) return null;
    var w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return { x: (nx * 0.5 + 0.5) * w, y: (1 - (ny * 0.5 + 0.5)) * h };
  };

  VolumeView.prototype.zoom = function (delta) {
    this.dist = Math.max(28, Math.min(190, this.dist * (1 + delta * 0.0012)));
  };

  ML.VolumeView = VolumeView;
})(window);
