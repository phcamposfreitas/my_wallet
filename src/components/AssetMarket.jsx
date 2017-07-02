import React, {Component} from 'react';
import {Row, Col, Button} from 'react-bootstrap';
import PropTypes from 'prop-types';

class AssetMarket extends Component {
    constructor(props) {
        super(props);
        const value = this.props.assetValue;

        this.state = {
            totalAtivos: 0,
            valorAtivo: value
        };

       this.handlePlusClick = this.handlePlusClick.bind(this);
    }

    handlePlusClick() {
        this.setState({
            totalAtivos: this.state.totalAtivos + 1
        })
    }

    render(){
        return (
            <Row className="clearfix">
                <Col 
                    md={4} 
                    mdOffset={4}
                >
                    {this.state.valorAtivo} * {this.state.totalAtivos} = {this.state.totalAtivos * this.state.valorAtivo}
                </Col>
                <Col md={4}>
                    <Button 
                            onClick={this.handlePlusClick}
                    >
                        +
                    </Button>
                </Col>
            </Row>
        );
    };
}

AssetMarket.propTypes = {
    assetValue: PropTypes.number.isRequired
}

export default AssetMarket;