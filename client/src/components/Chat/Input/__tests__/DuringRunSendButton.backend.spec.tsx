import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import DuringRunSendButton from '../DuringRunSendButton';

jest.mock('recoil', () => ({ useRecoilValue: () => true }));
jest.mock('react-hook-form', () => ({ useWatch: () => ({ text: 'Add a table' }) }));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { steerInterruptsByDefault: {}, enterToSend: {} },
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/hooks/Input/useComposerBindings', () => ({
  __esModule: true,
  default: () => ({ shortcutsEnabled: true, yieldedChords: new Set() }),
}));
jest.mock('@librechat/client', () => ({
  composerSubmitClasses: () => '',
  SendIcon: () => null,
  SendActions: ({ actions, anchor }: any) => (
    <>
      {anchor}
      {actions.map((a: any) => (
        <button key={a.key} disabled={a.disabled} onClick={a.onClick}>
          {a.label}
          <span>{a.kbd}</span>
        </button>
      ))}
    </>
  ),
}));
const controls = () => ({
  effectiveAction: 'steer' as const,
  canSteer: true,
  pausedOnApproval: false,
  canControlGeneration: false,
  steerFromComposer: jest.fn(() => false),
  queueFromComposer: jest.fn(() => false),
  interruptSteer: jest.fn(() => false),
  interruptAndSend: jest.fn(() => false),
});
const renderButton = (disabled = false, native = true) => {
  const steering = controls();
  const onConsumed = jest.fn();
  render(
    <DuringRunSendButton
      control={{} as any}
      steering={steering}
      getText={() => 'Add a table'}
      onConsumed={onConsumed}
      availableActions={native ? ['steer'] : undefined}
      interruptsByDefault={native ? false : undefined}
      disabled={disabled}
    />,
  );
  return { steering, onConsumed };
};
describe('shared during-run menu with native backend capabilities', () => {
  it('shows the native Steer action and delegates without prematurely consuming its draft', () => {
    const { steering, onConsumed } = renderButton();
    fireEvent.click(screen.getByText('com_ui_steer').closest('button')!);
    expect(steering.steerFromComposer).toHaveBeenCalledWith('Add a table');
    expect(onConsumed).not.toHaveBeenCalled();
    expect(screen.queryByText('com_ui_queue')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_interrupt_send')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_interrupt_steer')).not.toBeInTheDocument();
  });
  it('disables both anchor and menu action during a pending request', () => {
    const { steering } = renderButton(true);
    expect(screen.getByTestId('during-run-send-button')).toBeDisabled();
    fireEvent.click(screen.getByText('com_ui_steer').closest('button')!);
    expect(steering.steerFromComposer).not.toHaveBeenCalled();
  });
  it('retains the existing action menu when no capability filter is supplied', () => {
    renderButton(false, false);
    expect(screen.getByText('com_ui_queue')).toBeInTheDocument();
    expect(screen.getByText('com_ui_interrupt_send')).toBeInTheDocument();
    expect(screen.getByText('com_ui_interrupt_steer')).toBeInTheDocument();
  });
});
