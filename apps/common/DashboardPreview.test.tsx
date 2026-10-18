import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DashboardPreview from './DashboardPreview.js';

afterEach(cleanup);

describe('teacher dashboard preview', () => {
  it('opens without authentication and clearly labels synthetic data and unavailable screen capture', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    render(<DashboardPreview onConnect={() => {}} />);
    expect(screen.getByText('화면 미리보기')).toBeTruthy();
    expect(screen.getAllByText('공유된 화면이 없습니다')).toHaveLength(4);
    expect(screen.getAllByText('실시간 화면 미리보기가 아닙니다')).toHaveLength(6);
    expect(screen.getAllByRole('button', { name: /예시 학생 \d+ 기기 정보/ })).toHaveLength(6);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it('filters and searches devices and shows an honest detail view', () => {
    render(<DashboardPreview onConnect={() => {}} />);
    fireEvent.change(screen.getByLabelText('연결 상태 필터'), { target: { value: 'offline' } });
    expect(screen.getAllByRole('button', { name: /기기 정보/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '예시 학생 03 기기 정보' }));
    const detail = screen.getByRole('region', { name: '선택한 예시 기기' });
    expect(within(detail).getByText(/아직 구현되지 않았습니다/)).toBeTruthy();
    fireEvent.click(within(detail).getByText('상세 닫기'));
    expect(screen.queryByRole('region', { name: '선택한 예시 기기' })).toBeNull();
    fireEvent.change(screen.getByLabelText('학생 또는 기기 검색'), {
      target: { value: 'nonexistent' },
    });
    expect(screen.getByText('검색 결과가 없습니다')).toBeTruthy();
    fireEvent.click(screen.getByText('검색 초기화'));
    expect(screen.getAllByRole('button', { name: /기기 정보/ })).toHaveLength(6);
  });

  it('adds and deletes HTTPS materials locally without claiming actual delivery', () => {
    render(<DashboardPreview onConnect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /수업 자료/ }));
    fireEvent.change(screen.getByLabelText('자료 제목'), { target: { value: '시험 자료' } });
    fireEvent.change(screen.getByLabelText('자료 링크'), {
      target: { value: 'https://example.org/lesson' },
    });
    fireEvent.click(screen.getByText('미리보기 목록에 추가'));
    expect(screen.getByRole('link', { name: 'https://example.org/lesson' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('실제 전송은 하지 않았습니다');
    fireEvent.click(screen.getByRole('button', { name: '시험 자료 미리보기 삭제' }));
    expect(screen.queryByText('시험 자료')).toBeNull();
    fireEvent.change(screen.getByLabelText('자료 제목'), { target: { value: '위험 링크' } });
    fireEvent.change(screen.getByLabelText('자료 링크'), {
      target: { value: 'http://example.org/lesson' },
    });
    fireEvent.click(screen.getByText('미리보기 목록에 추가'));
    expect(screen.getByRole('status').textContent).toContain('HTTPS 주소');
    expect(screen.queryByText('위험 링크')).toBeNull();
  });

  it('previews focus and unavailable recordings without pretending to capture anything', () => {
    render(<DashboardPreview onConnect={() => {}} />);
    fireEvent.click(screen.getByText('집중 안내 켜기'));
    expect(
      screen.getByRole('button', { name: '집중 안내 끄기' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('실제 기기에는 전송되지 않습니다');
    fireEvent.click(screen.getByRole('button', { name: /녹화 보관함/ }));
    expect(screen.getByText('녹화 기능을 준비하고 있습니다')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '녹화 시작' })).toBeNull();
    fireEvent.click(screen.getByText('교실로 돌아가기'));
    expect(screen.getByRole('button', { name: '집중 안내 끄기' })).toBeTruthy();
  });

  it('updates the preview workspace name and offers the real authenticated screen', () => {
    const connect = vi.fn();
    render(<DashboardPreview onConnect={connect} />);
    fireEvent.click(screen.getByRole('button', { name: /작업공간 설정/ }));
    fireEvent.change(screen.getByLabelText('작업공간 이름'), { target: { value: '내 예시 공간' } });
    fireEvent.click(screen.getByText('미리보기 이름 변경'));
    expect(screen.getByText('내 예시 공간')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('서버에는 저장하지 않았습니다');
    fireEvent.click(screen.getByText('실제 로그인 화면으로'));
    expect(connect).toHaveBeenCalledOnce();
  });
});
