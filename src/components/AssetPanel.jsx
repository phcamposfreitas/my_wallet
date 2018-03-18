import React, { Component } from 'react';
import { Col, Row, Nav, NavItem, Tab, Well } from 'react-bootstrap';

import AssetInfo from './AssetInfo';

export default class AssetPanel extends Component {
    render() {
        const ASSETS = [
            { name: 'LTN 2023', class: 'Renda Fixa', year: '2023', owner: 'Tesouro Direto', type: 'Titulo Público', value: 5.23 },
            { name: 'CDB Pan', class: 'Renda Fixa', year: '2023', owner: 'Banco Pan', type: 'CDB', value: 8.03 },
            { name: 'LCI BB', class: 'Renda Fixa', year: '2023', owner: 'Banco do Brasil', type: 'LCI', value: 25.28 },
            { name: 'CMIG4', class: 'Renda Variável', year: '-', owner: 'CEMIG', type: 'Ações', value: 45.0 },
            { name: 'BOVA11', class: 'Renda Variável', year: '-', owner: 'Bovespa', type: 'ETF', value: 235.08 }
        ];

        return (
            <Tab.Container id="left-tabs-example" defaultActiveKey="0">
                <Row className="clearfix">
                    <Col md={4}>
                        <Nav bsStyle="pills" stacked>
                            {
                                ASSETS.map(asset => (
                                    <NavItem
                                        eventKey={asset.name}
                                        key={asset.name}
                                    >
                                        {asset.name}
                                    </NavItem>
                                ))
                            }
                        </Nav>
                    </Col>
                    <Col md={8}>
                        <Tab.Content animation>
                            {
                                ASSETS.map(asset => (
                                    <Tab.Pane
                                        eventKey={asset.name}
                                    >
                                        <AssetInfo
                                            asset={asset}
                                            key={asset.name}
                                        />
                                    </Tab.Pane>
                                ))
                            }
                        </Tab.Content>
                    </Col>
                </Row>
            </Tab.Container>
        );
    }
}