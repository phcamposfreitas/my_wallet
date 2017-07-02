import React, { Component } from 'react';
import { Col, Row, Nav, NavItem, Tab, Well } from 'react-bootstrap';

import AssetInfo from './AssetInfo';

export default class AssetPanel extends Component {
    render() {

        return (
            <Tab.Container id="left-tabs-example" defaultActiveKey="0">
                <Row className="clearfix">
                <Col md={4}>
                    <Nav bsStyle="pills" stacked>
                    {
                        this.props.assets.map(asset => (
                            <NavItem 
                                eventKey={asset.name}
                                key={asset.name}
                            >
                                { asset.name }
                            </NavItem>
                        ))
                    }
                    </Nav>
                </Col>
                <Col md={8}>
                    <Tab.Content animation>
                    {
                        this.props.assets.map(asset => (
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