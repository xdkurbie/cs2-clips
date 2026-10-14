//! Visual identity: dark slate surfaces with a single warm accent.

use eframe::egui::{self, Color32, CornerRadius, FontFamily, FontId, Stroke, TextStyle};

pub const BG: Color32 = Color32::from_rgb(14, 15, 19);
pub const PANEL: Color32 = Color32::from_rgb(20, 22, 28);
pub const CARD: Color32 = Color32::from_rgb(27, 30, 38);
pub const CARD_HOVER: Color32 = Color32::from_rgb(34, 38, 48);
pub const BORDER: Color32 = Color32::from_rgb(44, 48, 60);
pub const TEXT: Color32 = Color32::from_rgb(232, 234, 240);
pub const MUTED: Color32 = Color32::from_rgb(140, 146, 162);
pub const ACCENT: Color32 = Color32::from_rgb(255, 122, 26);
pub const ACCENT_DIM: Color32 = Color32::from_rgb(120, 62, 20);
pub const GOOD: Color32 = Color32::from_rgb(74, 210, 140);
pub const BAD: Color32 = Color32::from_rgb(240, 90, 90);
pub const T_COL: Color32 = Color32::from_rgb(222, 170, 70);
pub const CT_COL: Color32 = Color32::from_rgb(90, 150, 235);

pub fn apply(ctx: &egui::Context) {
    let mut v = egui::Visuals::dark();
    v.panel_fill = BG;
    v.window_fill = PANEL;
    v.extreme_bg_color = Color32::from_rgb(10, 11, 14);
    v.faint_bg_color = CARD;
    v.override_text_color = Some(TEXT);
    v.selection.bg_fill = ACCENT_DIM;
    v.selection.stroke = Stroke::new(1.0, ACCENT);
    v.hyperlink_color = ACCENT;
    v.window_corner_radius = CornerRadius::same(10);
    v.window_stroke = Stroke::new(1.0, BORDER);
    for (w, fill) in [
        (&mut v.widgets.noninteractive, CARD),
        (&mut v.widgets.inactive, Color32::from_rgb(36, 40, 50)),
        (&mut v.widgets.hovered, Color32::from_rgb(48, 53, 66)),
        (&mut v.widgets.active, ACCENT_DIM),
        (&mut v.widgets.open, Color32::from_rgb(40, 44, 56)),
    ] {
        w.bg_fill = fill;
        w.weak_bg_fill = fill;
        w.corner_radius = CornerRadius::same(6);
        w.bg_stroke = Stroke::new(1.0, BORDER);
    }
    v.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT);
    v.widgets.hovered.bg_stroke = Stroke::new(1.0, ACCENT);
    v.slider_trailing_fill = true;
    ctx.set_visuals(v);

    ctx.all_styles_mut(|s| {
        s.spacing.item_spacing = egui::vec2(8.0, 8.0);
        s.spacing.button_padding = egui::vec2(12.0, 6.0);
        s.spacing.interact_size.y = 30.0;
        s.text_styles = [
            (
                TextStyle::Heading,
                FontId::new(24.0, FontFamily::Proportional),
            ),
            (TextStyle::Body, FontId::new(14.5, FontFamily::Proportional)),
            (
                TextStyle::Button,
                FontId::new(14.5, FontFamily::Proportional),
            ),
            (
                TextStyle::Small,
                FontId::new(11.5, FontFamily::Proportional),
            ),
            (
                TextStyle::Monospace,
                FontId::new(13.0, FontFamily::Monospace),
            ),
        ]
        .into();
    });
}

/// A deterministic colour per map name, used for the generated match tiles.
pub fn map_color(map: &str) -> Color32 {
    match map.trim_start_matches("de_") {
        "mirage" => Color32::from_rgb(196, 140, 72),
        "inferno" => Color32::from_rgb(190, 84, 50),
        "nuke" => Color32::from_rgb(70, 150, 170),
        "ancient" => Color32::from_rgb(60, 140, 90),
        "anubis" => Color32::from_rgb(70, 110, 190),
        "dust2" => Color32::from_rgb(210, 175, 100),
        "vertigo" => Color32::from_rgb(120, 130, 200),
        "overpass" => Color32::from_rgb(100, 160, 120),
        "train" => Color32::from_rgb(150, 120, 100),
        other => {
            let h = other
                .bytes()
                .fold(7u32, |a, b| a.wrapping_mul(31).wrapping_add(b as u32));
            Color32::from_rgb(
                80 + (h % 120) as u8,
                80 + ((h >> 8) % 120) as u8,
                80 + ((h >> 16) % 120) as u8,
            )
        }
    }
}

pub fn chip(ui: &mut egui::Ui, text: &str, color: Color32) {
    egui::Frame::new()
        .fill(color.gamma_multiply(0.18))
        .stroke(Stroke::new(1.0, color.gamma_multiply(0.6)))
        .corner_radius(CornerRadius::same(10))
        .inner_margin(egui::Margin::symmetric(8, 2))
        .show(ui, |ui| {
            ui.label(egui::RichText::new(text).size(11.0).color(color).strong());
        });
}

pub fn card<R>(ui: &mut egui::Ui, add: impl FnOnce(&mut egui::Ui) -> R) -> egui::InnerResponse<R> {
    egui::Frame::new()
        .fill(CARD)
        .stroke(Stroke::new(1.0, BORDER))
        .corner_radius(CornerRadius::same(10))
        .inner_margin(egui::Margin::same(14))
        .show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.vertical(add).inner
        })
}

pub fn accent_button(text: &str) -> egui::Button<'_> {
    egui::Button::new(egui::RichText::new(text).color(Color32::BLACK).strong()).fill(ACCENT)
}

/// Fixed-width card for grids.
pub fn tile_card<R>(
    ui: &mut egui::Ui,
    width: f32,
    add: impl FnOnce(&mut egui::Ui) -> R,
) -> egui::InnerResponse<R> {
    egui::Frame::new()
        .fill(CARD)
        .stroke(Stroke::new(1.0, BORDER))
        .corner_radius(CornerRadius::same(10))
        .inner_margin(egui::Margin::same(12))
        .show(ui, |ui| {
            ui.set_width(width);
            ui.vertical(add).inner
        })
}
