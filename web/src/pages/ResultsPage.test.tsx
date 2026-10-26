import { screen } from '@testing-library/react';
import { DEMO, mockApi, renderApp } from '../test/render';

const RESULT = {
  status: 'READY',
  outcome: 'NEW_PRESCRIPTION',
  doctorNote: 'Your new glasses will make reading easier.',
  doctorName: 'Dr Ayesha',
  appointment: { date: '2030-01-07T04:00:00.000Z', type: 'Follow-up visit' },
  recordedAt: '2030-01-07T04:20:00.000Z',
  edited: false,
  editedAt: null,
};

describe('results', () => {
  it('W20. says when the glasses are ready to collect', async () => {
    mockApi({ 'GET /me': { body: DEMO }, 'GET /me/outcome': { body: { ...RESULT, glassesReadyAt: '2030-01-14T07:00:00.000Z' } } });
    renderApp('/results');

    expect(await screen.findByText('Your new glasses will make reading easier.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your glasses are ready to collect (since 14 January).');
  });

  it('W21. says nothing about glasses before they are ready', async () => {
    mockApi({ 'GET /me': { body: DEMO }, 'GET /me/outcome': { body: { ...RESULT, glassesReadyAt: null } } });
    renderApp('/results');

    expect(await screen.findByText('Your new glasses will make reading easier.')).toBeInTheDocument();
    expect(screen.queryByText(/glasses are ready/)).toBeNull();
  });
});
