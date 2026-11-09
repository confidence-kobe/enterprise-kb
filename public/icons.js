/**
 * 线条图标（与界面同一套风格，替代 emoji，在不同系统上显示一致）。
 * 用法：element.innerHTML = ICONS.copy；图标颜色跟随文字颜色（currentColor），
 * 大小默认 16px，可以用父元素的 CSS 覆盖 .icon 的宽高。
 * 问答页和管理页都在自己的脚本之前加载这个文件。
 */
;(() => {
  const svg = (body, extra = '') =>
    `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`

  window.ICONS = {
    sun:        svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>'),
    moon:       svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
    star:       svg('<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>'),
    x:          svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    check:      svg('<path d="M20 6 9 17l-5-5"/>'),
    copy:       svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    thumbUp:    svg('<path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>'),
    thumbDown:  svg('<path d="M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>'),
    alert:      svg('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>'),
    info:       svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
    retry:      svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
    search:     svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    chevron:    svg('<path d="m9 18 6-6-6-6"/>'),
    chevronDown:svg('<path d="m6 9 6 6 6-6"/>'),
    arrowLeft:  svg('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
    arrowRight: svg('<path d="M5 12h14M12 5l7 7-7 7"/>'),
    arrowUp:    svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    stop:       '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
    file:       svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>'),
    book:       svg('<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>'),
    inbox:      svg('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
    user:       svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    sparkle:    svg('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>'),
    zap:        svg('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>'),
    spinner:    svg('<path d="M21 12a9 9 0 1 1-6.2-8.56"/>', ' data-spin'),
  }
})()
