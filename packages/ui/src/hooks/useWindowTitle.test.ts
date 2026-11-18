import { describe, expect, test } from 'bun:test';

import { resolveWindowTitleProject } from './useWindowTitle';

const projects = [
  { id: 'webserver-local', path: '/workspace/webserver-local', label: 'webserver-local' },
  { id: 'other', path: '/workspace/other', label: 'other' },
];

describe('resolveWindowTitleProject', () => {
  test('project session resolves to its project even when the global active project is stale', () => {
    const project = resolveWindowTitleProject({
      projects,
      worktreesByProject: new Map(),
      currentSessionDirectory: '/workspace/other',
      activeProjectId: 'webserver-local',
      isChat: false,
      spaceProjectDirectory: null,
    });

    expect(project?.id).toBe('other');
  });

  test('chat session resolves to no project instead of the stale active project', () => {
    const project = resolveWindowTitleProject({
      projects,
      worktreesByProject: new Map(),
      // A managed chat directory lives under no project.
      currentSessionDirectory: '/Users/test/.config/openchamber/chats/2026-08-27/session-a',
      activeProjectId: 'webserver-local',
      isChat: true,
      spaceProjectDirectory: null,
    });

    expect(project).toBeNull();
  });

  test('chat directory nested under a project still resolves to no project', () => {
    const project = resolveWindowTitleProject({
      projects: [{ id: 'home', path: '/Users/test', label: 'home' }],
      worktreesByProject: new Map(),
      currentSessionDirectory: '/Users/test/.config/openchamber/chats/2026-08-27/session-a',
      activeProjectId: 'home',
      isChat: true,
      spaceProjectDirectory: null,
    });

    expect(project).toBeNull();
  });

  test('worktree session resolves to its parent project', () => {
    const project = resolveWindowTitleProject({
      projects,
      worktreesByProject: new Map([
        ['/workspace/webserver-local', [{
          path: '/workspace/webserver-local-feature',
          projectDirectory: '/workspace/webserver-local',
          branch: 'feature',
          label: 'feature',
        }]],
      ]),
      currentSessionDirectory: '/workspace/webserver-local-feature',
      activeProjectId: null,
      isChat: false,
      spaceProjectDirectory: null,
    });

    expect(project?.id).toBe('webserver-local');
  });

  test('space session resolves through the space project directory', () => {
    const project = resolveWindowTitleProject({
      projects,
      worktreesByProject: new Map(),
      currentSessionDirectory: '/spaces/abc/work',
      activeProjectId: null,
      isChat: false,
      spaceProjectDirectory: '/workspace/webserver-local',
    });

    expect(project?.id).toBe('webserver-local');
  });

  test('no selected session falls back to the active project', () => {
    const project = resolveWindowTitleProject({
      projects,
      worktreesByProject: new Map(),
      currentSessionDirectory: null,
      activeProjectId: 'webserver-local',
      isChat: false,
      spaceProjectDirectory: null,
    });

    expect(project?.id).toBe('webserver-local');
  });
});
