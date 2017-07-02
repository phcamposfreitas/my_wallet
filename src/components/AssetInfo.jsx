import React, { Component } from 'react';
import { Col, Row, Well } from 'react-bootstrap';

import AssetMarket from './AssetMarket';

export default class AssetInfo extends Component {


    render() {
        const asset = this.props.asset;

        return (
            <Row 
                className="clearfix"
            >
                <Row 
                    className="clearfix"
                >
                    <Well>
                        <Row 
                            className="clearfix"
                        >
                            <Col 
                                md={4}
                            >
                                { asset.name }
                            </Col>
                            <Col 
                                md={4}
                            />
                            <Col 
                                md={4}
                            >
                                { asset.owner }
                            </Col>
                        </Row>
                        <Row 
                            className="clearfix"
                        >
                            <Col 
                                md={4}
                            >
                                { asset.type }
                            </Col>
                            <Col 
                                md={4}
                            >
                                { asset.year }
                            </Col>
                            <Col 
                                md={4}
                            >
                                { asset.class }
                            </Col>
                        </Row>                
                    </Well>
                </Row>
                <Row className="clearfix">
                    <AssetMarket assetValue={asset.value} />
                </Row>
                <Row 
                    className="clearfix"
                >
                    <Well>
                        <Row 
                            className="clearfix"
                        >
                            <Col 
                                md={4}
                            >
                                { asset.name }
                            </Col>
                            <Col 
                                md={4}
                            />
                            <Col 
                                md={4}
                            >
                                { asset.owner }
                            </Col>
                        </Row>
                        <Row 
                            className="clearfix"
                        >
                            <Col 
                                md={4}
                            >
                                { asset.type }
                            </Col>
                            <Col 
                                md={4}
                            >
                                { asset.year }
                            </Col>
                            <Col 
                                md={4}
                            >
                                { asset.class }
                            </Col>
                        </Row>                
                    </Well>
                </Row>                        
            </Row>
        );
    }
}






                                