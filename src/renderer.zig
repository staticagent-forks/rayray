const builtin = @import("builtin");
const std = @import("std");

const c = @import("c.zig");
const shaderc = @import("shaderc.zig");

const Blit = @import("blit.zig").Blit;
const Raytrace = @import("raytrace.zig").Raytrace;
const Options = @import("options.zig").Options;

pub const Renderer = struct {
    const Self = @This();

    device: c.WGPUDeviceId,
    surface: c.WGPUSurfaceId,
    queue: c.WGPUQueueId,
    swap_chain: c.WGPUSwapChainId,

    raytrace: Raytrace,
    blit: Blit,

    uniforms: c.rayUniforms,
    uniform_buf: c.WGPUBufferId,

    start_time_ms: i64,
    frame: u64,

    pub fn init(alloc: *std.mem.Allocator, options: Options, window: *c.GLFWwindow) !Self {
        // Extract the WGPU Surface from the platform-specific window
        const platform = builtin.os.tag;
        const surface = if (platform == .macos) surf: {
            // Time to do hilarious Objective-C runtime hacks, equivalent to
            //  [ns_window.contentView setWantsLayer:YES];
            //  id metal_layer = [CAMetalLayer layer];
            //  [ns_window.contentView setLayer:metal_layer];
            const objc = @import("objc.zig");
            const darwin = @import("darwin.zig");

            const cocoa_window = darwin.glfwGetCocoaWindow(window);
            const ns_window = @ptrCast(c.id, @alignCast(8, cocoa_window));

            const cv = objc.call(ns_window, "contentView");
            _ = objc.call_(cv, "setWantsLayer:", true);

            const ca_metal = objc.class("CAMetalLayer");
            const metal_layer = objc.call(ca_metal, "layer");

            _ = objc.call_(cv, "setLayer:", metal_layer);

            break :surf c.wgpu_create_surface_from_metal_layer(metal_layer);
        } else {
            std.debug.panic("Unimplemented on platform {}", .{platform});
        };

        ////////////////////////////////////////////////////////////////////////////
        // WGPU initial setup
        var adapter: c.WGPUAdapterId = 0;
        c.wgpu_request_adapter_async(&(c.WGPURequestAdapterOptions){
            .power_preference = c.WGPUPowerPreference._HighPerformance,
            .compatible_surface = surface,
        }, 2 | 4 | 8, false, adapter_cb, &adapter);

        const device = c.wgpu_adapter_request_device(
            adapter,
            0,
            &(c.WGPUCLimits){
                .max_bind_groups = 1,
            },
            true,
            null,
        );

        var width_: c_int = undefined;
        var height_: c_int = undefined;
        c.glfwGetFramebufferSize(window, &width_, &height_);
        const width = @intCast(u32, width_);
        const height = @intCast(u32, height_);

        ////////////////////////////////////////////////////////////////////////
        // Uniform buffers (shared by both raytracing and blitter)
        const uniform_buf = c.wgpu_device_create_buffer(
            device,
            &(c.WGPUBufferDescriptor){
                .label = "blit uniforms",
                .size = @sizeOf(c.rayUniforms),
                .usage = c.WGPUBufferUsage_UNIFORM | c.WGPUBufferUsage_COPY_DST,
                .mapped_at_creation = false,
            },
        );

        const rt = try Raytrace.init(alloc, device, width, height, uniform_buf);
        const blit = try Blit.init(alloc, device, rt.tex_view, uniform_buf);

        var out = Renderer{
            .device = device,
            .surface = surface,
            .queue = c.wgpu_device_get_default_queue(device),
            .swap_chain = undefined,

            .raytrace = rt,
            .blit = blit,

            .uniforms = .{
                .width_px = width,
                .height_px = height,
                .samples = 0,
                .samples_per_frame = options.samples_per_frame,

                .camera = rt.scene.camera,
            },
            .uniform_buf = uniform_buf,

            .start_time_ms = 0,
            .frame = 0,
        };

        out.resize_swap_chain(width, height);

        return out;
    }

    fn update_uniforms(self: *Self) void {
        c.wgpu_queue_write_buffer(
            self.queue,
            self.uniform_buf,
            0,
            @ptrCast([*c]const u8, &self.uniforms),
            @sizeOf(c.rayUniforms),
        );
    }

    pub fn redraw(self: *Self) void {
        self.update_uniforms();

        // Record the start time at the first frame, to skip startup time
        if (self.uniforms.samples == 0) {
            self.start_time_ms = std.time.milliTimestamp();
        } else if (@mod(self.frame, 10) == 0) {
            // Print stats occasionally
            std.debug.print("\r", .{});
            self.print_stats();
        }

        // Cast another set of rays, one per pixel
        self.raytrace.draw(self.uniforms.samples == 0);
        self.uniforms.samples += self.uniforms.samples_per_frame;
        self.frame += 1;

        // Begin the main render operation
        const next_texture = c.wgpu_swap_chain_get_next_texture(self.swap_chain);
        if (next_texture.view_id == 0) {
            std.debug.panic("Cannot acquire next swap chain texture", .{});
        }

        const cmd_encoder = c.wgpu_device_create_command_encoder(
            self.device,
            &(c.WGPUCommandEncoderDescriptor){ .label = "main encoder" },
        );
        self.blit.draw(next_texture, cmd_encoder);

        const cmd_buf = c.wgpu_command_encoder_finish(cmd_encoder, null);
        c.wgpu_queue_submit(self.queue, &cmd_buf, 1);
        c.wgpu_swap_chain_present(self.swap_chain);
    }

    fn prefix(v: *f64) u8 {
        if (v.* > 1_000_000_000) {
            v.* /= 1_000_000_000;
            return 'G';
        } else if (v.* > 1_000_000) {
            v.* /= 1_000_000;
            return 'M';
        } else if (v.* > 1_000) {
            v.* /= 1_000;
            return 'K';
        } else {
            return ' ';
        }
    }

    pub fn print_stats(self: *const Self) void {
        var ray_count = @intToFloat(f64, self.uniforms.width_px) *
            @intToFloat(f64, self.uniforms.height_px) *
            @intToFloat(f64, self.uniforms.samples);

        const dt_sec = @intToFloat(f64, std.time.milliTimestamp() - self.start_time_ms) / 1000.0;

        var rays_per_sec = ray_count / dt_sec;
        var rays_per_sec_prefix = prefix(&rays_per_sec);

        var ray_count_prefix = prefix(&ray_count);

        std.debug.print(
            "Rendered {d:.2} {c}rays in {d:.2} sec ({d:.2} {c}ray/sec, {} rays/pixel at {} x {})        ",
            .{
                ray_count,
                ray_count_prefix,
                dt_sec,
                rays_per_sec,
                rays_per_sec_prefix,
                self.uniforms.samples,
                self.uniforms.width_px,
                self.uniforms.height_px,
            },
        );
    }

    pub fn deinit(self: *Self) void {
        self.blit.deinit();
        self.raytrace.deinit();
        c.wgpu_buffer_destroy(self.uniform_buf);
    }

    pub fn update_size(self: *Self, width_: c_int, height_: c_int) void {
        const width = @intCast(u32, width_);
        const height = @intCast(u32, height_);

        self.uniforms.width_px = width;
        self.uniforms.height_px = height;
        self.uniforms.samples = 0;

        self.start_time_ms = std.time.milliTimestamp();

        self.resize_swap_chain(width, height);
        self.raytrace.resize(width, height);
        self.blit.bind(self.raytrace.tex_view, self.uniform_buf);
    }

    fn resize_swap_chain(self: *Self, width: u32, height: u32) void {
        self.swap_chain = c.wgpu_device_create_swap_chain(
            self.device,
            self.surface,
            &(c.WGPUSwapChainDescriptor){
                .usage = c.WGPUTextureUsage_OUTPUT_ATTACHMENT,
                .format = c.WGPUTextureFormat._Bgra8Unorm,
                .width = width,
                .height = height,
                .present_mode = c.WGPUPresentMode._Fifo,
            },
        );
    }
};

export fn adapter_cb(received: c.WGPUAdapterId, data: ?*c_void) void {
    @ptrCast(*c.WGPUAdapterId, @alignCast(8, data)).* = received;
}
