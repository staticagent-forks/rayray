#version 440
#pragma shader_stage(fragment)
#include "extern/rayray.h"

layout(location=0) out vec4 fragColor;

layout(set=0, binding=0, std430) uniform Uniforms {
    rayUniforms u;
};
layout(set=0, binding=1) buffer Scene {
    vec4[] scene_data;
};

#define SURFACE_EPSILON 1e-6
#define NORMAL_EPSILON  1e-8

struct hit_t {
    vec3 pos;
    uint index;
};

////////////////////////////////////////////////////////////////////////////////
// Jenkins hash function, specialized for a uint key
uint32_t hash(uint key) {
    uint h = 0;
    for (uint i=0; i < 4; ++i) {
        h += (key >> (i * 8)) & 0xFF;
        h += h << 10;
        h ^= h >> 6;
    }
    h += h << 3;
    h ^= h >> 11;
    h += h << 15;
    return h;
}

uint32_t hash_fast(uint rng_state) {
    // Xorshift algorithm from George Marsaglia's paper
    rng_state ^= (rng_state << 13);
    rng_state ^= (rng_state >> 17);
    rng_state ^= (rng_state << 5);
    return rng_state;
}

// Returns a pseudorandom value between -1 and 1
float rand(inout uint seed) {
    seed = hash_fast(seed);

    // https://stackoverflow.com/questions/4200224/random-noise-functions-for-glsl
    uint m = seed;

    const uint ieeeMantissa = 0x007FFFFFu; // binary32 mantissa bitmask
    const uint ieeeOne      = 0x3F800000u; // 1.0 in IEEE binary32

    m &= ieeeMantissa;                     // Keep only mantissa bits (fractional part)
    m |= ieeeOne;                          // Add fractional part to 1.0

    float  f = uintBitsToFloat(m);         // Range [1:2]
    return 2*f - 3.0;                      // Range [-1:1]
}

vec3 rand3(inout uint seed) {
    return vec3(rand(seed), rand(seed), rand(seed));
}

vec2 rand2(inout uint seed) {
    return vec2(rand(seed), rand(seed));
}

// Returns a coordinate uniformly distributed on a sphere's surface
vec3 rand3_on_sphere(inout uint seed) {
    while (true) {
        vec3 v = rand3(seed);
        float len = dot(v, v);
        if (len <= 1.0 && len > NORMAL_EPSILON) {
            return normalize(v);
        }
        seed++;
    }
}

// Returns a coordinate uniformly distributed in a circle of radius 1
vec2 rand2_in_circle(inout uint seed) {
    while (true) {
        vec2 v = rand2(seed);
        if (length(v) <= 1.0) {
            return v;
        }
        seed++;
    }
}

////////////////////////////////////////////////////////////////////////////////
float hit_plane(vec3 start, vec3 dir, vec3 norm, float off) {
    // dot(norm, pos) == off
    // dot(norm, start + n*dir) == off
    // dot(norm, start) + dot(norm, n*dir) == off
    // dot(norm, start) + n*dot(norm, dir) == off
    float d = (off - dot(norm, start)) / dot(norm, dir);
    return d;
}

float hit_sphere(vec3 start, vec3 dir, vec3 center, float r) {
    vec3 delta = center - start;
    float d = dot(delta, dir);
    vec3 nearest = start + dir * d;
    float min_distance = length(center - nearest);
    if (min_distance < r) {
        // Return the smallest positive intersection, plus some margin so we
        // don't get stuck against the surface.  If we're inside the
        // sphere, then this will be against a negative normal
        float q = sqrt(r*r - min_distance*min_distance);
        if (d > q + SURFACE_EPSILON) {
            return d - q;
        } else {
            return d + q;
        }
    } else {
        return -1;
    }
}

vec3 norm(vec3 pos, uvec4 shape) {
    uint offset = shape.y;
    switch (shape.x) {
        case SHAPE_SPHERE: {
            vec4 d = scene_data[offset];
            return normalize(pos - d.xyz);
        }
        case SHAPE_INFINITE_PLANE: // fallthrough
        case SHAPE_FINITE_PLANE: {
            vec4 d = scene_data[offset];
            return d.xyz;
        }
        default: // unimplemented
            return vec3(0);
    }
}

////////////////////////////////////////////////////////////////////////////////
// The lowest-level building block:
//  Raytraces to the next object in the scene,
//  returning a hit_t object of [pos, index]
hit_t trace(vec3 start, vec3 dir) {
    float best_dist = 1e8;
    uint best_hit = 0;
    const uint num_shapes = floatBitsToUint(scene_data[0].x);

    for (uint i=1; i <= num_shapes; i += 1) {
        uvec4 shape = floatBitsToUint(scene_data[i]);
        uint offset = shape.y;
        float dist;
        switch (shape.x) {
            case SHAPE_SPHERE: {
                vec4 d = scene_data[offset];
                dist = hit_sphere(start, dir, d.xyz, d.w);
                break;
            }
            case SHAPE_INFINITE_PLANE: {
                vec4 d = scene_data[offset];
                dist = hit_plane(start, dir, d.xyz, d.w);
                break;
            }
            default: // unimplemented shape
                continue;
        }
        if (dist > SURFACE_EPSILON && dist < best_dist) {
            best_dist = dist;
            best_hit = i;
        }
    }
    hit_t t = {vec3(0), best_hit};
    if (best_hit != 0) {
        t.pos = start + dir*best_dist;
    }
    return t;
}

// Normalize, snapping to the normal if the vector is pathologically short
vec3 sanitize_dir(vec3 dir, vec3 norm) {
    float len = dot(dir, dir);
    if (len >= NORMAL_EPSILON) {
        return dir / sqrt(len);
    } else {
        return norm;
    }
}

#define BOUNCES 6
vec3 bounce(vec3 pos, vec3 dir, inout uint seed) {
    vec3 color = vec3(1);
    hit_t hit = {pos, 0};
    for (uint i=0; i < BOUNCES; ++i) {
        // Walk to the next object in the scene
        hit = trace(hit.pos, dir);

        // If we escaped the world, then terminate immediately
        if (hit.index == 0) {
            return vec3(0);
        }

        // Extract the shape so we can pull the material
        uvec4 shape = floatBitsToUint(scene_data[hit.index]);
        vec3 norm = norm(hit.pos, shape);

        // Look at the material and decide whether to terminate
        uint mat_offset = shape.z;
        uint mat_type = shape.w;

        switch (mat_type) {
            // When we hit a light, return immediately
            case MAT_LIGHT:
                return color * scene_data[mat_offset].xyz;

            // Otherwise, handle the various material types
            case MAT_DIFFUSE:
                color *= scene_data[mat_offset].xyz;
                dir = sanitize_dir(norm + rand3_on_sphere(seed), norm);
                break;
            case MAT_METAL:
                color *= scene_data[mat_offset].xyz;
                dir -= norm * dot(norm, dir)*2;
                float fuzz = scene_data[mat_offset].w;
                if (fuzz != 0) {
                    dir += rand3_on_sphere(seed) * fuzz;
                    if (fuzz >= 0.99) {
                        dir = sanitize_dir(dir, norm);
                    } else {
                        dir = normalize(dir);
                    }
                }
                break;
            case MAT_GLASS:
                // This doesn't support nested materials with different etas!
                float eta = scene_data[mat_offset].w;
                // If we're entering the shape, then decide whether to reflect
                // or refract based on the incoming angle
                if (dot(dir, norm) < 0) {
                    eta = 1/eta;

                    // Use Schlick's approximation for reflectance.
                    float cosine = min(dot(-dir, norm), 1.0);
                    float r0 = (1 - eta) / (1 + eta);
                    r0 = r0*r0;
                    float reflectance = r0 + (1 - r0) * pow((1 - cosine), 5);

                    // reflectance is [0-1], so bias rand() to match
                    if (reflectance > (rand(seed) + 1)*0.5) {
                        dir -= norm * dot(norm, dir)*2;
                    } else {
                        dir = refract(dir, norm, eta);
                    }
                } else {
                    // Otherwise, we're exiting the shape and need to check
                    // for total internal reflection
                    vec3 next_dir = refract(dir, -norm, eta);
                    // If we can't refract, then reflect instead
                    if (next_dir == vec3(0)) {
                        dir -= norm * dot(norm, dir)*2;
                    } else {
                        dir = next_dir;
                    }
                }
                break;
        }
    }
    // If we couldn't reach a light in max bounces, return black
    return vec3(0);
}

////////////////////////////////////////////////////////////////////////////////

void main() {
    // Set up our random seed based on the frame and pixel position
    uint seed = hash(hash(hash(u.samples) ^ floatBitsToUint(gl_FragCoord.x))
                                          ^ floatBitsToUint(gl_FragCoord.y));
    fragColor = vec4(0);

    // This is the ray direction from the center of the camera,
    // without any bias due to perspective
    const vec3 camera_dir = normalize(u.camera.target - u.camera.pos);

    // Build an orthonormal frame for the camera
    const vec3 camera_dx = cross(camera_dir, u.camera.up);
    const vec3 camera_dy = -cross(camera_dir, camera_dx);
    const mat3 camera_mat = mat3(camera_dx, camera_dy, camera_dir);

    const vec2 camera_scale = vec2(float(u.width_px) / float(u.height_px), 1);

    for (uint i=0; i < u.samples_per_frame; ++i) {
        // Add anti-aliasing by jittering within the pixel
        float pixel_dx = rand(seed) - 0.5;
        float pixel_dy = rand(seed) - 0.5;

        // Pixel position as a normalized [-1,1] value, with antialiasing
        vec2 pixel_xy = (gl_FragCoord.xy + vec2(pixel_dx, pixel_dy)) /
                         vec2(u.width_px, u.height_px) * 2 - 1;

        // Calculate the offset from camera center for this pixel, in 3D space,
        // then use this offset for both the start of the ray and for the
        // ray direction change due to perspective
        vec3 offset = camera_mat * vec3(camera_scale * pixel_xy, 0);
        vec3 start = u.camera.pos + offset;
        vec3 dir = normalize(camera_dir + u.camera.perspective * offset);

        // First, pick a target on the focal plane.
        // (This ends up with a curved focal plane, but that's fine)
        vec3 target = start + dir * u.camera.focal_distance;

        // Then, jitter the start position by the defocus amount
        vec2 defocus = u.camera.defocus * rand2_in_circle(seed);
        start += camera_mat * vec3(defocus, 0);

        // Finally, re-adjust the direction so that we hit the same target
        dir = normalize(target - start);

        // Actually do the raytracing here, accumulating color
        fragColor += vec4(bounce(start, dir, seed), 1);
    }
}
