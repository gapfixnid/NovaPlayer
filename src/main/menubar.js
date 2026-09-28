'use strict';
/**
 * 네이티브 메뉴 + 창 이벤트 관리
 *
 * 렌더러 쪽 자체 메뉴바(menu-bar.js)를 보조한다.
 * 실제 창 제어(최소화/전체화면/닫기)는 이쪽이 전담한다.
 */
const { app, Menu, shell, clipboard } = require('electron');

/** 창 버튼이 최소화/최대화/전체화면을 토글하는 데 필요한 최소 기능 세트 */
function buildWindowMenu({ onCommand }) {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: `${app.name} 정보` },
        { type: 'separator' },
        { role: 'services', label: '서비스' },
        { type: 'separator' },
        { role: 'hide', label: '가리기' },
        { role: 'hideOthers', label: '다른 항목 가리기' },
        { role: 'unhide', label: '모두 표시' },
        { type: 'separator' },
        { role: 'quit', label: '종료' },
      ],
    }] : []),
    {
      label: '창',
      submenu: [
        { label: ' 최소화', accelerator: 'Alt+Down', click: () => onCommand('minimize') },
        { label: ' 최대화/복원', click: () => onCommand('maximize') },
        { label: ' 전체화면', accelerator: 'F11', click: () => onCommand('fullscreen') },
        { type: 'separator' },
        { label: '항상 맨 위', accelerator: 'Control+Alt+T', click: () => onCommand('alwaysOnTop') },
        { type: 'separator' },
        { label: '닫기', accelerator: 'Alt+F4', click: () => onCommand('close') },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'quit', label: '종료' }]),
      ],
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행취소' },
        { role: 'redo', label: '다시실행' },
        { type: 'separator' },
        { role: 'cut', label: '오려두기' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '전체선택' },
        { type: 'separator' },
        { label: '파일 경로 복사', click: () => onCommand('copyPath') },
      ],
    },
    {
      label: '보기',
      submenu: [
        { role: 'reload', label: '새로고침' },
        { role: 'forceReload', label: '강력 새로고침' },
        { type: 'separator' },
        { role: 'resetZoom', label: '실제 크기' },
        { role: 'zoomIn', label: '확대' },
        { role: 'zoomOut', label: '축소' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체화면' },
        { role: 'toggleDevTools', label: '개발자 도구' },
      ],
    },
    {
      label: '도움말',
      submenu: [
        { label: '단축키 목록', click: () => onCommand('hotkeys') },
        { label: '재생 정보', click: () => onCommand('playbackInfo') },
        { type: 'separator' },
        { label: '프로젝트 폴더 열기', click: () => shell.openPath(app.getAppPath()) },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

function installWindowMenu(getWindow, onCommand) {
  Menu.setApplicationMenu(buildWindowMenu({ onCommand }));
}

module.exports = { installWindowMenu, buildWindowMenu };
