import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { focused, panes, terminals, spaces, theme, run, props, shared, window, settings } from "herdr";
import { liveStatus, percent, dateTime, quotaStatus, resetSummary, capabilities } from "./status.js";

export default class SessionDetails extends View {
  init(_props, cx) {
    this.width = 268;
    if (!props()?.footer) cx.timer.every(15000, cx => cx.notify());
  }

  metric(label, value, color, detail = "") {
    const t = theme();
    const amount = percent(value);
    const exact = amount === null ? `${label}: unavailable` : `${label}: ${amount.toFixed(1)}%`;
    const description = detail ? `${exact}. ${detail}` : exact;
    return v_flex().flex_1().min_w(0).gap(5).tooltip(description).accessibility_label(description)
      .child(div().h(28).line_height(14).text_size(11.5).text_color(t.muted).child(label.replace(" ", "\n")))
      .child(div().text_size(14).font_normal().text_color(t.muted).child(amount === null ? "—" : `${Math.round(amount)}%`))
      .child(div().mt(3).h(3).w_full().bg(t.border).rounded(2).overflow_hidden()
        .when(amount !== null, el => el.child(div().h(3).w(`${amount}%`).bg(color).rounded(2))));
  }

  render() {
    const t = theme();
    const font = settings().font_family ?? "JetBrains Mono";
    const focus = focused();
    const address = focus?.shown ?? focus?.terminal;
    const pane = panes().find(p => p.terminal === address);
    const terminal = terminals().find(item => item.address === address);
    const status = liveStatus(terminal);
    const quota = quotaStatus(status);
    const supported = capabilities(status);
    const program = terminal?.program ?? pane?.program;
    const reported = status?.version === 2 && status.client !== "pi" && quota
      ? `reported ${dateTime(quota.fetchedAt)} (local time)` : "";
    const folder = status?.cwd ?? pane?.cwd ?? focus?.cwd;
    const space = spaces().find(s => s.active);

    if (props()?.footer) {
      return h_flex().font_family(font).size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
        .child((space?.machine ?? "this computer").toLowerCase())
        .when(Boolean(pane?.branch), el => el.child(pane.branch.toLowerCase()))
        .child(div().flex_1())
        .child(div().id("palette").cursor_pointer().on_click(() => run("app.palette"))
          .child(`${window()?.platform === "macos" ? "⌘" : "ctrl"} shift p  commands`));
    }

    const root = v_flex().id("session-details").font_family(font).size_full().min_w(0).bg(t.chrome).border_t(1).border_color(t.border)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); });
    if (this.width < 160) {
      return root.items_center().pt(12).gap(12)
        .child(div().id("expand-details").cursor_pointer().tooltip("show session details").accessibility_label("show session details")
          .on_click(() => run("layout.resize", { id: "sidebar", px: shared("sidebar.width") ?? 268 }))
          .child(program?.icon
            ? (program.tint ? svg(program.icon) : image(program.icon)).size(18).text_color(t.muted)
            : svg("mods/workspace-chrome/sidebar.svg").size(18).text_color(t.muted)))
        .child(div().text_size(11).text_color(t.muted).child(percent(status?.contextPercent) === null ? "—" : `${Math.round(status.contextPercent)}%`));
    }
    const effort = (status?.effort ?? "").toLowerCase();
    const resets = resetSummary(quota);
    const sessionReset = quota?.sessionResetAt ? `resets ${dateTime(quota.sessionResetAt)} (local time)` : "";
    const weeklyReset = quota?.weeklyResetAt ? `resets ${dateTime(quota.weeklyResetAt)} (local time)` : "";
    const help = space?.machine ? "install the adapter on this machine." : {
      pi: "run /reload in pi to connect.",
      claude: "connect the claude code status line.",
      codex: "send a prompt; if still blank, check the hooks.",
    }[program?.key] ?? "connect a pi, claude code or codex adapter.";
    return root.p(16).gap(16).text_size(12).overflow_y_scrollbar()
      .child(v_flex().gap(7)
        .child(h_flex().gap(12).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_normal().text_color(t.foreground)
            .tooltip(status?.model?.id ?? "session details").child((status?.model?.name ?? program?.name ?? "session details").toLowerCase()))
          .child(div().flex_none().text_size(11.5).text_color(t.muted)
            .tooltip(`reasoning effort: ${effort || "unavailable"}`).accessibility_label(`reasoning effort: ${effort || "unavailable"}`).child(effort)))
        .child(h_flex().gap(14).items_center().text_color(t.muted)
          .child(h_flex().flex_1().min_w(0).gap(5).items_center().tooltip(folder ?? "folder unavailable").accessibility_label(`folder: ${folder ?? "unavailable"}`)
            .child(svg("mods/workspace-chrome/folder.svg").size(12).flex_none())
            .child(div().min_w(0).truncate().child((folder?.split(/[\\/]/).filter(Boolean).at(-1) || folder || "—").toLowerCase())))
          .when(Boolean(pane?.branch), el => el.child(h_flex().min_w(0).max_w("50%").gap(5).items_center()
            .tooltip(`branch: ${pane.branch}`).accessibility_label(`branch: ${pane.branch}`)
            .child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none())
            .child(div().min_w(0).truncate().child(pane.branch.toLowerCase()))))))
      .child(h_flex().gap(12)
        .child(this.metric("context used", status?.contextPercent, t.muted))
        .when(supported.session, el => el.child(this.metric("5h remaining", quota?.sessionLeft, t.muted, [sessionReset, reported].filter(Boolean).join(". "))))
        .when(supported.weekly, el => el.child(this.metric("weekly remaining", quota?.weeklyLeft, t.muted, [weeklyReset, reported].filter(Boolean).join(". ")))))
      .when(supported.resetCredits, el => el.child(h_flex().gap(8).items_center().text_size(11.5).text_color(t.muted)
        .tooltip([resets.detail, reported].filter(Boolean).join(". ")).accessibility_label(`${resets.label}. ${resets.detail}`)
        .child(div().flex_1().min_w(0).truncate().child(resets.label))
        .child(div().flex_none().child(resets.expiry))))
      .when(!status, el => el.child(div().text_size(11.5).text_color(t.muted).child(help)));
  }
}
