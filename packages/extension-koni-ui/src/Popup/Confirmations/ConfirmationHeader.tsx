// Copyright 2019-2022 @subwallet/extension-koni-ui authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { ThemeProps } from '@subwallet/extension-koni-ui/types';
import { Icon, SwSubHeader } from '@subwallet/react-ui';
import { ButtonProps } from '@subwallet/react-ui/es/button';
import CN from 'classnames';
import { CaretRight } from 'phosphor-react';
import React from 'react';
import styled from 'styled-components';

interface Props extends ThemeProps {
  index: number,
  numberOfConfirmations: number,
  onClickPrev: () => void,
  onClickNext: () => void,
  title?: string,
}

function Component ({ className, index, numberOfConfirmations, onClickNext, onClickPrev, title }: Props) {
  const rightButtons: ButtonProps[] = ([{
    className: CN('__right-block', { hidden: index === (numberOfConfirmations - 1) }),
    onClick: onClickNext,
    size: 'xs',
    icon: (<Icon
      phosphorIcon={CaretRight}
      size='sm'
    />)
  }]);

  return (
    <SwSubHeader
      background='transparent'
      center={true}
      className={CN(className)}
      onBack={onClickPrev}
      paddingVertical={true}
      rightButtons={rightButtons}
      showBackButton={index > 0}
      title={title}
    />
  );
}

const ConfirmationHeader = styled(Component)<Props>(({ theme }: ThemeProps) => {
  return {};
});

export default ConfirmationHeader;
