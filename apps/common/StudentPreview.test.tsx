import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import StudentPreview from './StudentPreview.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('shows a clearly labeled local-only student flow without contacting the API', () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  render(<StudentPreview onExit={() => {}} />);
  fireEvent.change(screen.getByLabelText('이름'), { target: { value: '예시 학생' } });
  fireEvent.change(screen.getByLabelText('학번'), { target: { value: '001' } });
  fireEvent.click(screen.getByRole('button', { name: '예시 참여 흐름 보기' }));
  expect(screen.getByText(/실제 교사에게 신청이 전달되지 않았습니다/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '예시 승인 후 화면 보기' }));
  expect(screen.getByText(/실제 교실 서버에 연결되지 않았습니다/)).toBeTruthy();
  expect(screen.getByText(/실제 화면 확인이나 녹화는 시작되지 않았습니다/)).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it('returns to the real account-free join flow only when explicitly selected', () => {
  const onExit = vi.fn();
  render(<StudentPreview onExit={onExit} />);
  fireEvent.click(screen.getByRole('button', { name: '실제 학생 참여 화면으로 돌아가기' }));
  expect(onExit).toHaveBeenCalledOnce();
});
